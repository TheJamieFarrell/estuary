/**
 * Tiny uniform adapter over whichever synchronous SQLite driver is available.
 *
 * Preference order:
 *   1. `better-sqlite3` (a dependency; `electron-builder install-app-deps` fetches a prebuilt
 *      binary for the current Electron ABI).
 *   2. Node's built-in `node:sqlite` `DatabaseSync` (Electron 44 ships Node 24) when requiring
 *      better-sqlite3 throws, e.g. because no prebuilt binary matched the ABI.
 *
 * Both drivers are exposed through the same `SqlDatabase` shape so the rest of the store never
 * has to care which one is in use. Parameters are normalised (undefined -> null, boolean -> 0/1)
 * because neither driver accepts JS booleans or undefined.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { log } from './log'

const nodeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

export type SqlDriver = 'better-sqlite3' | 'node:sqlite'

export type SqlValue = null | number | bigint | string | Uint8Array
export type SqlParam = SqlValue | boolean | undefined | Date

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[]
}

export interface SqlDatabase {
  readonly driver: SqlDriver
  /** True when the driver's SQLite build can create FTS5 tables. */
  readonly fts5: boolean
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  pragma(source: string): unknown
  close(): void
}

interface RawStatement {
  run(...params: SqlValue[]): { changes?: number | bigint; lastInsertRowid?: number | bigint }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): RawStatement
  close(): void
}

function normaliseParam(value: SqlParam): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return value
}

function normaliseParams(params: SqlParam[]): SqlValue[] {
  return params.map(normaliseParam)
}

function toNumber(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' ? value : 0
}

function wrapStatement(stmt: RawStatement): SqlStatement {
  return {
    run(...params: SqlParam[]): SqlRunResult {
      const r = stmt.run(...normaliseParams(params))
      return { changes: toNumber(r?.changes), lastInsertRowid: toNumber(r?.lastInsertRowid) }
    },
    get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined {
      const row = stmt.get(...normaliseParams(params))
      return (row ?? undefined) as T | undefined
    },
    all<T = Record<string, unknown>>(...params: SqlParam[]): T[] {
      return stmt.all(...normaliseParams(params)) as T[]
    }
  }
}

function openBetterSqlite3(file: string): RawDatabase | null {
  try {
    const Ctor = nodeRequire('better-sqlite3') as new (path: string) => RawDatabase
    return new Ctor(file)
  } catch (err) {
    log.warn('better-sqlite3 unavailable, falling back to node:sqlite —', (err as Error)?.message)
    return null
  }
}

function openNodeSqlite(file: string): RawDatabase {
  const mod = nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => RawDatabase
  }
  return new mod.DatabaseSync(file, { open: true, enableForeignKeyConstraints: true })
}

function detectFts5(db: SqlDatabase): boolean {
  let compiled = false
  try {
    const row = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS ok").get<{ ok: number }>()
    compiled = Number(row?.ok ?? 0) === 1
  } catch {
    compiled = false
  }
  let usable = false
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)')
    db.exec('DROP TABLE temp.__fts5_probe')
    usable = true
  } catch (err) {
    log.warn('FTS5 probe failed:', (err as Error)?.message)
  }
  log.info(`FTS5: compileoption=${compiled ? 'yes' : 'no'} usable=${usable ? 'yes' : 'no'}`)
  return usable
}

/**
 * Open (creating if needed) a database file. Pass ':memory:' for an in-memory database.
 * Applies WAL, synchronous=NORMAL and foreign_keys=ON.
 */
export function openDatabase(file: string): SqlDatabase {
  if (file !== ':memory:' && !file.startsWith('file:')) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      /* directory already exists */
    }
  }

  let driver: SqlDriver = 'better-sqlite3'
  let raw = openBetterSqlite3(file)
  if (!raw) {
    driver = 'node:sqlite'
    raw = openNodeSqlite(file)
  }
  log.info(`sqlite driver: ${driver} (${file})`)

  const rawDb = raw
  let depth = 0
  let closed = false

  const db: SqlDatabase = {
    driver,
    fts5: false,
    exec(sql: string): void {
      rawDb.exec(sql)
    },
    prepare(sql: string): SqlStatement {
      return wrapStatement(rawDb.prepare(sql))
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
      return (...args: A): R => {
        const savepoint = `db_sp_${depth}`
        if (depth === 0) rawDb.exec('BEGIN')
        else rawDb.exec(`SAVEPOINT ${savepoint}`)
        depth += 1
        try {
          const result = fn(...args)
          depth -= 1
          if (depth === 0) rawDb.exec('COMMIT')
          else rawDb.exec(`RELEASE ${savepoint}`)
          return result
        } catch (err) {
          depth -= 1
          try {
            if (depth === 0) rawDb.exec('ROLLBACK')
            else rawDb.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
          } catch {
            /* the transaction is already gone */
          }
          throw err
        }
      }
    },
    pragma(source: string): unknown {
      const stmt = rawDb.prepare(`PRAGMA ${source}`)
      try {
        const rows = stmt.all() as Record<string, unknown>[]
        if (rows.length === 0) return undefined
        const first = rows[0]
        const keys = Object.keys(first)
        return rows.length === 1 && keys.length === 1 ? first[keys[0] as string] : rows
      } catch {
        stmt.run()
        return undefined
      }
    },
    close(): void {
      if (closed) return
      closed = true
      try {
        rawDb.close()
      } catch (err) {
        log.warn('close failed:', (err as Error)?.message)
      }
    }
  }

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 5000')
  ;(db as { fts5: boolean }).fts5 = detectFts5(db)

  return db
}
