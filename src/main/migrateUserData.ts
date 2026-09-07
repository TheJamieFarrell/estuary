/**
 * One-time move of the data directory left by the app's previous name (UniMail) into the
 * Estuary one. Copies everything (the SQLite database, attachment cache, and Chromium's
 * `Local State`, which holds the safeStorage key that encrypts account secrets) so nobody
 * has to sign in again. Runs before the store opens; a failure just logs and continues.
 */
import { app } from 'electron'
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import log from 'electron-log/main'

const OLD_NAME = 'UniMail'
const OLD_DB = 'unimail.db'
const NEW_DB = 'estuary.db'
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'logs', 'Crashpad'])

export function migrateLegacyUserData(): void {
  const scope = log.scope('migrate')
  try {
    const userData = app.getPath('userData')
    const legacy = join(dirname(userData), OLD_NAME)
    const alreadyMigrated = existsSync(join(userData, NEW_DB)) || existsSync(join(userData, OLD_DB))
    if (alreadyMigrated || !existsSync(join(legacy, OLD_DB))) {
      renameDb(userData)
      return
    }
    scope.info(`moving data from ${legacy} to ${userData}`)
    for (const entry of readdirSync(legacy)) {
      if (SKIP.has(entry)) continue
      const from = join(legacy, entry)
      const to = join(userData, entry)
      if (existsSync(to)) continue
      cpSync(from, to, { recursive: true, errorOnExist: false, force: false })
    }
    renameDb(userData)
    // Leave a marker in the old folder so a stray old install does not resync from scratch silently.
    try {
      rmSync(join(legacy, OLD_DB), { force: true })
      rmSync(join(legacy, `${OLD_DB}-wal`), { force: true })
      rmSync(join(legacy, `${OLD_DB}-shm`), { force: true })
    } catch {
      /* best effort */
    }
    scope.info('legacy data migrated')
  } catch (err) {
    scope.warn('legacy data migration failed', err)
  }
}

function renameDb(userData: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(userData, `${OLD_DB}${suffix}`)
    const to = join(userData, `${NEW_DB}${suffix}`)
    if (existsSync(from) && !existsSync(to)) renameSync(from, to)
  }
}
