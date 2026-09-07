/**
 * In-place updates without a server. `npm run dist` drops the installer plus an `update.json`
 * manifest into the release folder; the running app polls that folder, and "Update now" runs the
 * installer silently. The NSIS installer upgrades in place and relaunches, and all user data
 * (accounts, tokens, cached mail) lives in userData, so nothing has to be signed in again.
 *
 * Update source lookup order:
 *   1. <userData>/update-source.json        { "dir": "C:\\path\\to\\release" }
 *   2. <resources>/update-source.json       (packaged; copied from config/update-source.local.json)
 *   3. <project>/release                    (dev fallback)
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { UpdateInfo } from '@shared/ipc'

const scope = log.scope('updater')
const MANIFEST = 'update.json'
const CHECK_EVERY_MS = 60 * 60_000
const FIRST_CHECK_MS = 20_000

interface Manifest {
  version: string
  file: string
  builtAt?: number
  notes?: string
}

export interface Updater {
  start(): void
  stop(): void
  check(): UpdateInfo | null
  install(): { ok: boolean; error?: string }
  sourceDir(): string | undefined
}

/** Compare dotted versions numerically; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (err) {
    scope.warn(`could not read ${file}`, err)
    return undefined
  }
}

export function resolveUpdateSource(): string | undefined {
  const candidates = [
    join(app.getPath('userData'), 'update-source.json'),
    app.isPackaged ? join(process.resourcesPath, 'update-source.json') : join(app.getAppPath(), 'config', 'update-source.local.json')
  ]
  for (const file of candidates) {
    const cfg = readJson<{ dir?: string }>(file)
    if (cfg?.dir && existsSync(cfg.dir)) return cfg.dir
  }
  if (!app.isPackaged) {
    const dev = join(app.getAppPath(), 'release')
    if (existsSync(dev)) return dev
  }
  return undefined
}

export function createUpdater(opts: {
  onAvailable: (info: UpdateInfo) => void
  beforeInstall?: () => void
}): Updater {
  let timer: NodeJS.Timeout | null = null
  let pending: UpdateInfo | null = null
  let announced: string | undefined

  function check(): UpdateInfo | null {
    const dir = resolveUpdateSource()
    if (!dir) return null
    const manifest = readJson<Manifest>(join(dir, MANIFEST))
    if (!manifest?.version || !manifest.file) return null
    const current = app.getVersion()
    if (compareVersions(manifest.version, current) <= 0) {
      pending = null
      return null
    }
    const installerPath = join(dir, manifest.file)
    if (!existsSync(installerPath)) {
      scope.warn(`manifest points at a missing installer: ${installerPath}`)
      return null
    }
    // Ignore an installer that is still being written by electron-builder.
    const age = Date.now() - statSync(installerPath).mtimeMs
    if (age < 15_000) return null
    pending = {
      version: manifest.version,
      currentVersion: current,
      installerPath,
      builtAt: manifest.builtAt,
      notes: manifest.notes
    }
    if (announced !== manifest.version) {
      announced = manifest.version
      scope.info(`update available: ${current} -> ${manifest.version} (${installerPath})`)
      try {
        opts.onAvailable(pending)
      } catch (err) {
        scope.warn('onAvailable failed', err)
      }
    }
    return pending
  }

  function install(): { ok: boolean; error?: string } {
    const info = pending ?? check()
    if (!info) return { ok: false, error: 'No update is waiting to be installed.' }
    if (!app.isPackaged) return { ok: false, error: 'Updates only apply to the installed app, not the dev build.' }
    try {
      scope.info(`launching installer ${info.installerPath}`)
      // NSIS: /S silent. The installer waits for this process to exit, upgrades in place and
      // relaunches UniMail; user data is untouched.
      const child = spawn(info.installerPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      opts.beforeInstall?.()
      setTimeout(() => app.quit(), 300)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      scope.error('installer launch failed', err)
      return { ok: false, error: message }
    }
  }

  return {
    start() {
      if (timer) return
      setTimeout(() => {
        try {
          check()
        } catch (err) {
          scope.warn('update check failed', err)
        }
      }, FIRST_CHECK_MS).unref()
      timer = setInterval(() => {
        try {
          check()
        } catch (err) {
          scope.warn('update check failed', err)
        }
      }, CHECK_EVERY_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    check,
    install,
    sourceDir: resolveUpdateSource
  }
}
