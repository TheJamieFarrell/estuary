/**
 * Filesystem layout. Everything UniMail writes lives under `app.getPath('userData')`
 * (on Windows: %APPDATA%\UniMail).
 */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '@main/contracts'

let cached: AppPaths | null = null

export function getAppPaths(): AppPaths {
  if (cached) return cached
  const userData = app.getPath('userData')
  const paths: AppPaths = {
    userData,
    dbFile: join(userData, 'unimail.db'),
    attachmentsDir: join(userData, 'attachments'),
    logsDir: join(userData, 'logs')
  }
  for (const dir of [paths.userData, paths.attachmentsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true })
  }
  cached = paths
  return paths
}

/** Per-account attachment cache directory (created on demand). */
export function accountAttachmentsDir(paths: AppPaths, accountId: string): string {
  return join(paths.attachmentsDir, accountId)
}

/**
 * Where the bundled `resources/` folder lives at runtime.
 * Dev: <project>/resources. Packaged: <install>/resources/resources (see `extraResources`).
 */
export function getResourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
}

/** Path to the JSON file remembering the main window's bounds. */
export function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}
