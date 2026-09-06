import { describe, expect, it } from 'vitest'
import {
  archiveTargetKind,
  buildFolderPath,
  detectInboxPrefixed,
  mapFolderKind,
  mapFolders,
  providerQuirks,
  type MailboxInfo
} from './providers'

const box = (path: string, extra: Partial<MailboxInfo> = {}): MailboxInfo => ({
  path,
  delimiter: '/',
  ...extra
})

describe('special use attributes', () => {
  it('wins over names', () => {
    expect(mapFolderKind('imap', box('Weird Name', { specialUse: '\\Sent' }))).toBe('sent')
    expect(mapFolderKind('imap', box('Whatever', { flags: new Set(['\\HasNoChildren', '\\Junk']) }))).toBe('spam')
    expect(mapFolderKind('imap', box('X', { specialUse: '\\All' }))).toBe('all')
    expect(mapFolderKind('imap', box('X', { specialUse: '\\Flagged' }))).toBe('starred')
  })

  it('always maps INBOX', () => {
    expect(mapFolderKind('gmail', box('INBOX'))).toBe('inbox')
    expect(mapFolderKind('imap', box('inbox'))).toBe('inbox')
  })
})

describe('gmail', () => {
  it('maps the [Gmail] container paths', () => {
    expect(mapFolderKind('gmail', box('[Gmail]/All Mail'))).toBe('all')
    expect(mapFolderKind('gmail', box('[Gmail]/Sent Mail'))).toBe('sent')
    expect(mapFolderKind('gmail', box('[Gmail]/Spam'))).toBe('spam')
    expect(mapFolderKind('gmail', box('[Gmail]/Trash'))).toBe('trash')
    expect(mapFolderKind('gmail', box('[Gmail]/Drafts'))).toBe('drafts')
    expect(mapFolderKind('gmail', box('[Gmail]/Starred'))).toBe('starred')
    expect(mapFolderKind('gmail', box('[Gmail]/Important'))).toBe('important')
    expect(mapFolderKind('gmail', box('[Google Mail]/All Mail'))).toBe('all')
  })

  it('keeps user labels custom', () => {
    expect(mapFolderKind('gmail', box('Clients'))).toBe('custom')
    expect(mapFolderKind('gmail', box('Clients/Archive'))).toBe('custom')
  })

  it('syncs All Mail and archives into it', () => {
    const quirks = providerQuirks('gmail')
    expect(quirks.defaultSyncedKinds).toContain('all')
    expect(quirks.hasSupersetFolder).toBe(true)
    expect(quirks.bodyPrefetchKinds).toEqual(['inbox'])
    expect(archiveTargetKind(quirks)).toBe('all')
    expect(quirks.smtpAutoSavesSent).toBe(true)
    expect(quirks.maxConnections).toBe(15)
  })
})

describe('outlook', () => {
  it('maps the English folder names', () => {
    expect(mapFolderKind('outlook', box('Sent Items'))).toBe('sent')
    expect(mapFolderKind('outlook', box('Deleted Items'))).toBe('trash')
    expect(mapFolderKind('outlook', box('Junk Email'))).toBe('spam')
    expect(mapFolderKind('outlook', box('Archive'))).toBe('archive')
    expect(mapFolderKind('outlook', box('Drafts'))).toBe('drafts')
  })

  it('has no All Mail and archives into Archive', () => {
    const quirks = providerQuirks('outlook')
    expect(quirks.defaultSyncedKinds).not.toContain('all')
    expect(archiveTargetKind(quirks)).toBe('archive')
    expect(quirks.smtpAutoSavesSent).toBe(true)
  })
})

describe('spacemail / generic imap', () => {
  it('maps INBOX prefixed folders with a dot delimiter', () => {
    const dotted = (path: string): MailboxInfo => ({ path, delimiter: '.' })
    expect(mapFolderKind('spacemail', dotted('INBOX.Sent'))).toBe('sent')
    expect(mapFolderKind('spacemail', dotted('INBOX.Trash'))).toBe('trash')
    expect(mapFolderKind('spacemail', dotted('INBOX.Junk'))).toBe('spam')
    expect(mapFolderKind('spacemail', dotted('INBOX.Drafts'))).toBe('drafts')
    expect(mapFolderKind('spacemail', dotted('INBOX.Archive'))).toBe('archive')
    expect(mapFolderKind('spacemail', dotted('INBOX.Projects'))).toBe('custom')
  })

  it('maps localised names', () => {
    expect(mapFolderKind('imap', box('Elementos enviados'))).toBe('sent')
    expect(mapFolderKind('imap', box('Papierkorb'))).toBe('trash')
    expect(mapFolderKind('imap', box('Corbeille'))).toBe('trash')
    expect(mapFolderKind('imap', box('Éléments envoyés'))).toBe('sent')
    expect(mapFolderKind('imap', box('Posta indesiderata'))).toBe('spam')
    expect(mapFolderKind('imap', box('Concepten'))).toBe('drafts')
  })

  it('needs an APPEND to Sent after sending', () => {
    expect(providerQuirks('spacemail').smtpAutoSavesSent).toBe(false)
    expect(providerQuirks('imap').smtpAutoSavesSent).toBe(false)
    expect(providerQuirks('spacemail').maxConnections).toBe(3)
  })
})

describe('mapFolders', () => {
  it('assigns each kind once and marks the synced set', () => {
    const mapped = mapFolders('gmail', [
      box('INBOX'),
      box('[Gmail]/All Mail', { specialUse: '\\All' }),
      box('[Gmail]/Sent Mail', { specialUse: '\\Sent' }),
      box('[Gmail]/Trash', { specialUse: '\\Trash' }),
      box('[Gmail]/Spam', { specialUse: '\\Junk' }),
      box('[Gmail]/Drafts', { specialUse: '\\Drafts' }),
      box('Archive'),
      box('Work/Archive'),
      box('Work')
    ])
    const kinds = mapped.map((m) => m.kind)
    expect(kinds.filter((k) => k === 'archive')).toHaveLength(1)
    expect(mapped.find((m) => m.path === 'Work/Archive')?.kind).toBe('custom')
    expect(mapped.find((m) => m.path === 'INBOX')?.synced).toBe(true)
    expect(mapped.find((m) => m.path === 'Work')?.synced).toBe(false)
    expect(mapped.find((m) => m.path === '[Gmail]/All Mail')?.synced).toBe(true)
  })

  it('falls back to custom when a kind is already taken', () => {
    const mapped = mapFolders('imap', [box('INBOX'), box('Sent'), box('Sent Items')])
    const sent = mapped.filter((m) => m.kind === 'sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('Sent')
  })

  it('keeps the leaf name', () => {
    const mapped = mapFolders('spacemail', [{ path: 'INBOX.Team.Alerts', delimiter: '.' }])
    expect(mapped[0]?.name).toBe('Alerts')
    expect(mapped[0]?.kind).toBe('custom')
  })
})

describe('folder paths', () => {
  it('builds paths with the server delimiter', () => {
    expect(buildFolderPath('Receipts', { delimiter: '/', inboxPrefixed: false })).toBe('Receipts')
    expect(buildFolderPath('Receipts', { delimiter: '.', inboxPrefixed: true })).toBe('INBOX.Receipts')
    expect(buildFolderPath('Receipts', { parentPath: 'INBOX.Work', delimiter: '.', inboxPrefixed: true })).toBe('INBOX.Work.Receipts')
  })

  it('detects INBOX prefixed servers', () => {
    expect(detectInboxPrefixed(['INBOX', 'INBOX.Sent', 'INBOX.Trash'], '.')).toBe(true)
    expect(detectInboxPrefixed(['INBOX', 'Sent', 'Trash'], '.')).toBe(false)
    expect(detectInboxPrefixed(['INBOX'], '.')).toBe(false)
  })
})
