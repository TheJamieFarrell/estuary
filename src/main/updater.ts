/**
 * In-place updates without an update server. `npm run dist` drops the installer plus an
 * `update.json` manifest into the release folder; installed copies poll a manifest, and
 * "Update now" runs the installer silently. The NSIS installer upgrades in place and relaunches,
 * and all user data (accounts, tokens, cached mail) lives in userData, so nothing has to be signed
 * in again.
 *
 * Update source lookup order:
 *   1. <userData>/update-source.json        { "dir": "C:\\path\\to\\release" } | { "url": "https://…" }
 *   2. <resources>/update-source.json       (packaged; copied from config/update-source.local.json)
 *      <project>/config/update-source.local.json (dev)
 *   3. the public GitHub release manifest    (packaged builds)
 *   4. <project>/release                    (dev fallback)
 *
 * A folder source is read straight off disk. A URL source fetches the manifest, and only downloads
 * the installer when the user actually accepts the update; the download is verified against the
 * manifest's sha512 before it is launched.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import log from 'electron-log/main'
import type { UpdateInfo } from '@shared/ipc'

const scope = log.scope('updater')
const MANIFEST = 'update.json'
const CHECK_EVERY_MS = 60 * 60_000
const FIRST_CHECK_MS = 20_000
const MANIFEST_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const PROGRESS_EVERY_MS = 200

/** Where public builds look when nothing else is configured. */
export const DEFAULT_MANIFEST_URL = 'https://github.com/TheJamieFarrell/estuary/releases/latest/download/update.json'

export interface Manifest {
  version: string
  file: string
  /** Base64 SHA-512 of the installer, as electron-builder encodes it. */
  sha512?: string
  size?: number
  builtAt?: number
  notes?: string
}

export type UpdateSource = { kind: 'dir'; dir: string } | { kind: 'url'; url: string }

export interface DownloadProgress {
  transferred: number
  total?: number
}

export interface Updater {
  start(): void
  stop(): void
  check(): Promise<UpdateInfo | null>
  install(): Promise<{ ok: boolean; error?: string }>
  /** The folder updates are read from, when the source is a local folder. */
  sourceDir(): string | undefined
  /** The resolved update source, folder or remote manifest URL. */
  source(): UpdateSource | undefined
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

/** The installer sits next to its manifest, so swap the last path segment. */
export function resolveInstallerUrl(manifestUrl: string, file: string): string {
  const name = file.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (!name) throw new Error('manifest has no installer file name')
  return new URL(name, manifestUrl).toString()
}

/** Base64 SHA-512 of a buffer, matching the encoding electron-builder writes. */
export function sha512Base64(data: Uint8Array): string {
  return createHash('sha512').update(data).digest('base64')
}

/** True when a digest matches the expected one; tolerates hex manifests and stray whitespace. */
export function matchesSha512(actual: string, expected: string | undefined): boolean {
  if (!expected) return true
  const norm = (s: string): string => s.trim().replace(/=+$/, '')
  if (norm(actual) === norm(expected)) return true
  // Some tools publish the hex digest instead; accept that too rather than blocking an update.
  if (/^[0-9a-f]{128}$/i.test(expected.trim())) {
    return Buffer.from(actual, 'base64').toString('hex').toLowerCase() === expected.trim().toLowerCase()
  }
  return false
}

/** Streaming SHA-512 so a 100MB installer is never held in memory. */
export async function hashFileSha512(file: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(file), hash)
  return hash.digest('base64')
}

/** Pick a source out of one update-source.json, ignoring folders that are not there. */
export function parseSourceConfig(
  cfg: { dir?: string; url?: string } | undefined,
  dirExists: (dir: string) => boolean = existsSync
): UpdateSource | undefined {
  if (!cfg) return undefined
  if (cfg.dir && dirExists(cfg.dir)) return { kind: 'dir', dir: cfg.dir }
  if (cfg.url && /^https?:\/\//i.test(cfg.url)) return { kind: 'url', url: cfg.url }
  return undefined
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

export function resolveUpdateSource(): UpdateSource | undefined {
  const candidates = [
    join(app.getPath('userData'), 'update-source.json'),
    app.isPackaged
      ? join(process.resourcesPath, 'update-source.json')
      : join(app.getAppPath(), 'config', 'update-source.local.json')
  ]
  for (const file of candidates) {
    const source = parseSourceConfig(readJson<{ dir?: string; url?: string }>(file))
    if (source) return source
  }
  if (app.isPackaged) return { kind: 'url', url: DEFAULT_MANIFEST_URL }
  const dev = join(app.getAppPath(), 'release')
  if (existsSync(dev)) return { kind: 'dir', dir: dev }
  return undefined
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<Manifest>
  return typeof m.version === 'string' && !!m.version && typeof m.file === 'string' && !!m.file
}

/** Fetch the manifest. GitHub's releases/latest/download/… is a redirect, so follow them. */
async function fetchManifest(url: string): Promise<Manifest | undefined> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), MANIFEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: control.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }
    })
    if (!res.ok) {
      scope.warn(`manifest fetch failed: ${res.status} ${res.statusText} (${url})`)
      return undefined
    }
    const body = (await res.json()) as unknown
    if (!isManifest(body)) {
      scope.warn(`manifest at ${url} is missing version/file`)
      return undefined
    }
    return body
  } catch (err) {
    scope.warn(`manifest fetch failed (${url})`, err)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Download to a temp file, then rename, so a killed download never looks complete. */
async function download(url: string, dest: string, onProgress?: (info: DownloadProgress) => void): Promise<void> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: control.signal, headers: { 'cache-control': 'no-cache' } })
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('download failed: empty response body')
    const declared = Number(res.headers.get('content-length'))
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
    let transferred = 0
    let lastTick = 0
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          transferred += chunk.length
          const now = Date.now()
          if (onProgress && now - lastTick >= PROGRESS_EVERY_MS) {
            lastTick = now
            try {
              onProgress({ transferred, total })
            } catch (err) {
              scope.warn('onProgress failed', err)
            }
          }
          yield chunk
        }
      },
      createWriteStream(dest)
    )
    try {
      onProgress?.({ transferred, total: total ?? transferred })
    } catch (err) {
      scope.warn('onProgress failed', err)
    }
  } finally {
    clearTimeout(timer)
  }
}

function remove(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch (err) {
    scope.warn(`could not delete ${file}`, err)
  }
}

export function createUpdater(opts: {
  onAvailable: (info: UpdateInfo) => void
  beforeInstall?: () => void
  onProgress?: (info: DownloadProgress) => void
}): Updater {
  let timer: NodeJS.Timeout | null = null
  let pending: UpdateInfo | null = null
  let announced: string | undefined

  function announce(info: UpdateInfo): UpdateInfo {
    pending = info
    if (announced !== info.version) {
      announced = info.version
      scope.info(`update available: ${info.currentVersion} -> ${info.version} (${info.downloadUrl ?? info.installerPath})`)
      try {
        opts.onAvailable(info)
      } catch (err) {
        scope.warn('onAvailable failed', err)
      }
    }
    return info
  }

  function checkDir(dir: string, current: string): UpdateInfo | null {
    const manifest = readJson<Manifest>(join(dir, MANIFEST))
    if (!isManifest(manifest)) return null
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
    return announce({
      version: manifest.version,
      currentVersion: current,
      installerPath,
      builtAt: manifest.builtAt,
      notes: manifest.notes,
      source: 'dir',
      size: manifest.size,
      sha512: manifest.sha512
    })
  }

  async function checkUrl(url: string, current: string): Promise<UpdateInfo | null> {
    const manifest = await fetchManifest(url)
    if (!manifest) return null
    if (compareVersions(manifest.version, current) <= 0) {
      pending = null
      return null
    }
    let downloadUrl: string
    try {
      downloadUrl = resolveInstallerUrl(url, manifest.file)
    } catch (err) {
      scope.warn(`could not resolve the installer url from ${url}`, err)
      return null
    }
    return announce({
      version: manifest.version,
      currentVersion: current,
      installerPath: downloadPath(manifest.file),
      builtAt: manifest.builtAt,
      notes: manifest.notes,
      source: 'url',
      downloadUrl,
      size: manifest.size,
      sha512: manifest.sha512
    })
  }

  function downloadPath(file: string): string {
    const name = file.split(/[\\/]/).filter(Boolean).pop() ?? 'Estuary-Setup.exe'
    return join(app.getPath('temp'), 'estuary-updates', name)
  }

  async function check(): Promise<UpdateInfo | null> {
    const source = resolveUpdateSource()
    if (!source) return null
    const current = app.getVersion()
    if (source.kind === 'dir') return checkDir(source.dir, current)
    return checkUrl(source.url, current)
  }

  /** Make sure the installer named by `info` is on disk and matches its digest. */
  async function fetchInstaller(info: UpdateInfo): Promise<string> {
    if (info.source !== 'url' || !info.downloadUrl) return info.installerPath
    const dest = info.installerPath
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest) && info.sha512 && matchesSha512(await hashFileSha512(dest), info.sha512)) {
      scope.info(`reusing already downloaded installer ${dest}`)
      return dest
    }
    if (existsSync(dest)) remove(dest)
    scope.info(`downloading ${info.downloadUrl} -> ${dest}`)
    try {
      await download(info.downloadUrl, dest, opts.onProgress)
    } catch (err) {
      remove(dest)
      throw err
    }
    if (info.sha512) {
      const actual = await hashFileSha512(dest)
      if (!matchesSha512(actual, info.sha512)) {
        remove(dest)
        throw new Error('The downloaded installer failed its checksum and was discarded.')
      }
      scope.info('installer checksum verified')
    } else {
      scope.warn('manifest has no sha512; installing an unverified download')
    }
    return dest
  }

  async function install(): Promise<{ ok: boolean; error?: string }> {
    const info = pending ?? (await check())
    if (!info) return { ok: false, error: 'No update is waiting to be installed.' }
    if (!app.isPackaged) return { ok: false, error: 'Updates only apply to the installed app, not the dev build.' }
    try {
      const installerPath = await fetchInstaller(info)
      scope.info(`launching installer ${installerPath}`)
      // NSIS: /S silent. The installer waits for this process to exit, upgrades in place and
      // relaunches Estuary; user data is untouched.
      const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      opts.beforeInstall?.()
      setTimeout(() => app.quit(), 300)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      scope.error('install failed', err)
      return { ok: false, error: message }
    }
  }

  /** Timers must never throw, and a failed check is only ever a warning. */
  function safeCheck(): void {
    check().catch((err: unknown) => scope.warn('update check failed', err))
  }

  return {
    start() {
      if (timer) return
      setTimeout(safeCheck, FIRST_CHECK_MS).unref()
      timer = setInterval(safeCheck, CHECK_EVERY_MS)
      timer.unref()
      // Also look when the user comes back to the window, at most every few minutes.
      let lastFocusCheck = 0
      app.on('browser-window-focus', () => {
        if (Date.now() - lastFocusCheck < 3 * 60_000) return
        lastFocusCheck = Date.now()
        safeCheck()
      })
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    check,
    install,
    sourceDir() {
      const source = resolveUpdateSource()
      return source?.kind === 'dir' ? source.dir : undefined
    },
    source: resolveUpdateSource
  }
}
