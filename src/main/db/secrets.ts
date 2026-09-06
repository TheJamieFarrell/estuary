/**
 * Encryption for account secrets (passwords, OAuth refresh tokens).
 *
 * Uses Electron's `safeStorage`, which is backed by DPAPI on Windows. Outside Electron
 * (unit tests, tooling) `safeStorage` is unavailable, so we fall back to a clearly-logged
 * base64 no-op. Every blob carries a 4-byte magic header saying how it was written, so a
 * database created in one mode still decrypts correctly in the other where possible.
 */
import { createRequire } from 'node:module'
import { log } from './log'

const nodeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

const MAGIC_ENCRYPTED = Buffer.from('UMS1', 'ascii')
const MAGIC_PLAIN = Buffer.from('UMP1', 'ascii')

let safeStorage: SafeStorageLike | null | undefined
let warned = false

function getSafeStorage(): SafeStorageLike | null {
  if (safeStorage !== undefined) return safeStorage
  safeStorage = null
  try {
    const electron = nodeRequire('electron') as { safeStorage?: SafeStorageLike } | string
    if (electron && typeof electron === 'object' && electron.safeStorage) {
      safeStorage = electron.safeStorage
    }
  } catch {
    safeStorage = null
  }
  return safeStorage
}

/** True when real OS-backed encryption is in use. */
export function isEncryptionAvailable(): boolean {
  const ss = getSafeStorage()
  if (!ss) return false
  try {
    return ss.isEncryptionAvailable()
  } catch {
    return false
  }
}

function warnOnce(): void {
  if (warned) return
  warned = true
  log.warn(
    'safeStorage is not available — account secrets will be stored base64-encoded, NOT encrypted. ' +
      'This is expected in tests; inside Electron make sure the store is opened after app.whenReady().'
  )
}

/** Encrypt a string into a blob suitable for a BLOB column. */
export function encryptSecret(plain: string): Buffer {
  if (isEncryptionAvailable()) {
    const ss = getSafeStorage() as SafeStorageLike
    return Buffer.concat([MAGIC_ENCRYPTED, Buffer.from(ss.encryptString(plain))])
  }
  warnOnce()
  return Buffer.concat([MAGIC_PLAIN, Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'ascii')])
}

/** Decrypt a blob written by {@link encryptSecret}. Returns undefined when it cannot be read. */
export function decryptSecret(blob: Uint8Array | Buffer | null | undefined): string | undefined {
  if (!blob || blob.length === 0) return undefined
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const magic = buf.subarray(0, 4)
  const body = buf.subarray(4)
  try {
    if (magic.equals(MAGIC_PLAIN)) {
      return Buffer.from(body.toString('ascii'), 'base64').toString('utf8')
    }
    if (magic.equals(MAGIC_ENCRYPTED)) {
      const ss = getSafeStorage()
      if (!ss || !isEncryptionAvailable()) {
        log.error('cannot decrypt account secret: safeStorage is unavailable in this process')
        return undefined
      }
      return ss.decryptString(Buffer.from(body))
    }
    // Unknown/legacy header: try safeStorage on the whole blob, then plain utf8.
    const ss = getSafeStorage()
    if (ss && isEncryptionAvailable()) {
      try {
        return ss.decryptString(buf)
      } catch {
        /* fall through */
      }
    }
    return buf.toString('utf8')
  } catch (err) {
    log.error('failed to decrypt account secret:', (err as Error)?.message)
    return undefined
  }
}

/** Convenience helpers for JSON payloads (OAuth token bundles). */
export function encryptJson(value: unknown): Buffer {
  return encryptSecret(JSON.stringify(value))
}

export function decryptJson<T>(blob: Uint8Array | Buffer | null | undefined): T | undefined {
  const raw = decryptSecret(blob)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}
