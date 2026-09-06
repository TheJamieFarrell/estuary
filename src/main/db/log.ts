/**
 * Scoped logger for the storage module.
 *
 * Uses electron-log (`electron-log/main`) when it can be loaded, which is the case inside the
 * Electron main process. Unit tests run under plain node/vitest where `electron-log/main`
 * touches the Electron `app` object, so loading is guarded and falls back to the console.
 */
import { createRequire } from 'node:module'

const nodeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

type LogFn = (...args: unknown[]) => void

export interface DbLogger {
  info: LogFn
  warn: LogFn
  error: LogFn
  debug: LogFn
}

interface ElectronLogLike {
  default?: ElectronLogLike
  scope?: (name: string) => Partial<DbLogger>
  info?: LogFn
  warn?: LogFn
  error?: LogFn
  debug?: LogFn
}

let resolved: Partial<DbLogger> | null = null
let tried = false

function resolveLogger(): Partial<DbLogger> | null {
  if (tried) return resolved
  tried = true
  try {
    const mod = nodeRequire('electron-log/main') as ElectronLogLike
    const base = (mod.default ?? mod) as ElectronLogLike
    resolved = typeof base.scope === 'function' ? base.scope('db') : (base as Partial<DbLogger>)
  } catch {
    resolved = null
  }
  return resolved
}

function make(level: keyof DbLogger): LogFn {
  return (...args: unknown[]): void => {
    const target = resolveLogger()
    const fn = target?.[level]
    if (typeof fn === 'function') {
      try {
        fn(...args)
        return
      } catch {
        /* fall through to console */
      }
    }
    // Without electron-log, debug output is dropped so tests stay quiet.
    if (level === 'debug') return
    // eslint-disable-next-line no-console
    const c = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log
    c('[db]', ...args)
  }
}

export const log: DbLogger = {
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
  debug: make('debug')
}
