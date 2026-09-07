import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// updater.ts pulls in electron and electron-log at module load; neither exists under plain node.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.2.0',
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    on: () => {},
    quit: () => {}
  }
}))

vi.mock('electron-log/main', () => {
  const noop = (): void => {}
  const logger = { info: noop, warn: noop, error: noop, debug: noop, scope: () => logger }
  return { default: logger }
})

const {
  compareVersions,
  DEFAULT_MANIFEST_URL,
  hashFileSha512,
  matchesSha512,
  parseSourceConfig,
  resolveInstallerUrl,
  sha512Base64
} = await import('./updater')

const dir = mkdtempSync(join(tmpdir(), 'estuary-updater-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('compareVersions', () => {
  it('orders released versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.2', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  it('reads a dashed suffix as a further segment', () => {
    expect(compareVersions('0.2.0-2', '0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.2.0-1')).toBeLessThan(0)
  })

  it('does not crash on junk, counting unparsable segments as zero', () => {
    expect(compareVersions('', '')).toBe(0)
    expect(compareVersions('v1', '0')).toBe(0)
    expect(compareVersions('v1', '1')).toBeLessThan(0)
  })
})

describe('resolveInstallerUrl', () => {
  it('swaps the manifest name for the installer name', () => {
    expect(resolveInstallerUrl(DEFAULT_MANIFEST_URL, 'Estuary-Setup-0.2.1.exe')).toBe(
      'https://github.com/TheJamieFarrell/estuary/releases/latest/download/Estuary-Setup-0.2.1.exe'
    )
  })

  it('keeps deeper paths intact', () => {
    expect(resolveInstallerUrl('https://estuary.email/updates/win/update.json', 'Estuary-Setup.exe')).toBe(
      'https://estuary.email/updates/win/Estuary-Setup.exe'
    )
  })

  it('drops a query string and any path in the file name', () => {
    expect(resolveInstallerUrl('https://example.com/a/update.json?v=2', 'nested/Estuary-Setup.exe')).toBe(
      'https://example.com/a/Estuary-Setup.exe'
    )
  })

  it('encodes an awkward file name rather than producing a broken url', () => {
    expect(resolveInstallerUrl('https://example.com/a/update.json', 'Estuary Setup.exe')).toBe(
      'https://example.com/a/Estuary%20Setup.exe'
    )
  })

  it('rejects a manifest with no file name', () => {
    expect(() => resolveInstallerUrl('https://example.com/a/update.json', '')).toThrow()
  })
})

describe('sha512 verification', () => {
  const data = Buffer.from('estuary installer bytes')
  const digest = createHash('sha512').update(data).digest('base64')

  it('matches electron-builder base64 encoding', () => {
    expect(sha512Base64(data)).toBe(digest)
  })

  it('accepts the matching digest and rejects anything else', () => {
    expect(matchesSha512(digest, digest)).toBe(true)
    expect(matchesSha512(digest, sha512Base64(Buffer.from('tampered')))).toBe(false)
  })

  it('accepts a hex digest too', () => {
    const hex = createHash('sha512').update(data).digest('hex')
    expect(matchesSha512(digest, hex)).toBe(true)
    expect(matchesSha512(digest, hex.replace(/.$/, '0'))).toBe(false)
  })

  it('skips verification when the manifest declares no digest', () => {
    expect(matchesSha512(digest, undefined)).toBe(true)
  })

  it('hashes a file on disk the same way', async () => {
    const file = join(dir, 'installer.bin')
    writeFileSync(file, data)
    await expect(hashFileSha512(file)).resolves.toBe(digest)
  })
})

describe('parseSourceConfig', () => {
  const exists = (d: string): boolean => d === 'C:/releases'

  it('prefers a folder that is actually there', () => {
    expect(parseSourceConfig({ dir: 'C:/releases' }, exists)).toEqual({ kind: 'dir', dir: 'C:/releases' })
  })

  it('falls through when the folder is gone', () => {
    expect(parseSourceConfig({ dir: 'C:/missing' }, exists)).toBeUndefined()
    expect(parseSourceConfig({ dir: 'C:/missing', url: 'https://example.com/update.json' }, exists)).toEqual({
      kind: 'url',
      url: 'https://example.com/update.json'
    })
  })

  it('takes an http(s) url', () => {
    expect(parseSourceConfig({ url: DEFAULT_MANIFEST_URL }, exists)).toEqual({ kind: 'url', url: DEFAULT_MANIFEST_URL })
  })

  it('ignores an empty or non-http config', () => {
    expect(parseSourceConfig(undefined, exists)).toBeUndefined()
    expect(parseSourceConfig({}, exists)).toBeUndefined()
    expect(parseSourceConfig({ url: 'file:///c:/releases/update.json' }, exists)).toBeUndefined()
  })
})
