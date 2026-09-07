import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMailStore } from './index'
import type { MailStore, MessageUpsert } from '../contracts'

const flags = { seen: false, flagged: false, answered: false, draft: false, forwarded: false }

function msg(folderId: string, uid: number, gmMsgid: string, extra: Partial<MessageUpsert> = {}): MessageUpsert {
  return {
    accountId: '',
    folderId,
    uid,
    messageIdHeader: `<${gmMsgid}@example.com>`,
    references: [],
    gmThrid: `t-${gmMsgid}`,
    gmMsgid,
    subject: `Subject ${gmMsgid}`,
    from: [{ address: 'alice@example.com', name: 'Alice' }],
    to: [{ address: 'me@gmail.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: Date.now(),
    flags,
    hasAttachments: false,
    size: 100,
    ...extra
  }
}

describe('Gmail All Mail dedupe', () => {
  let dir: string
  let store: MailStore
  let accountId: string
  let inbox: string
  let all: string
  let trash: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unimail-dedupe-'))
    store = createMailStore()
    store.open(join(dir, 'test.db'))
    const account = store.addAccount({
      email: 'me@gmail.com',
      name: 'Me',
      provider: 'gmail',
      authType: 'password',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      username: 'me@gmail.com',
      password: 'x'
    })
    accountId = account.id
    const folders = store.replaceFolders(accountId, [
      { accountId, path: 'INBOX', name: 'INBOX', delimiter: '/', kind: 'inbox', synced: true },
      { accountId, path: '[Gmail]/All Mail', name: 'All Mail', delimiter: '/', kind: 'all', synced: true },
      { accountId, path: '[Gmail]/Trash', name: 'Trash', delimiter: '/', kind: 'trash', synced: true }
    ])
    inbox = folders.find((f) => f.kind === 'inbox')!.id
    all = folders.find((f) => f.kind === 'all')!.id
    trash = folders.find((f) => f.kind === 'trash')!.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not store the All Mail mirror of a message already in INBOX', () => {
    const a = store.upsertMessage({ ...msg(inbox, 10, 'm1'), accountId })
    const b = store.upsertMessage({ ...msg(all, 500, 'm1'), accountId })
    expect(a.isNew).toBe(true)
    expect(b.isNew).toBe(false)
    expect(b.message.id).toBe(a.message.id)
    expect(store.listUids(all)).toEqual([])
    const thread = store.getThreadSummary(a.message.threadId)!
    expect(thread.messageCount).toBe(1)
    expect(thread.unreadCount).toBe(1)
  })

  it('moves an All Mail-only message into INBOX when it shows up there', () => {
    const archived = store.upsertMessage({ ...msg(all, 500, 'm2'), accountId })
    expect(archived.isNew).toBe(true)
    const inInbox = store.upsertMessage({ ...msg(inbox, 11, 'm2'), accountId })
    expect(inInbox.isNew).toBe(false)
    expect(inInbox.message.id).toBe(archived.message.id)
    expect(inInbox.message.folderId).toBe(inbox)
    expect(store.listUids(all)).toEqual([])
    expect(store.listUids(inbox)).toEqual([11])
  })

  it('demotes a message that left INBOX to All Mail instead of deleting it, then adopts the real uid', () => {
    const m = store.upsertMessage({ ...msg(inbox, 12, 'm3'), accountId })
    store.reconcileUids(inbox, [], 1) // server says INBOX is empty now (archived)
    const summary = store.getMessageSummary(m.message.id)!
    expect(summary.folderId).toBe(all)
    expect(summary.uid).toBeLessThan(0)
    // All Mail sync now reports the message on uid 501: adopt the placeholder, no duplicate.
    const adopted = store.upsertMessage({ ...msg(all, 501, 'm3'), accountId })
    expect(adopted.isNew).toBe(false)
    expect(adopted.message.id).toBe(m.message.id)
    expect(store.listUids(all)).toEqual([501])
  })

  it('really deletes a message that left Trash', () => {
    const m = store.upsertMessage({ ...msg(trash, 3, 'm4'), accountId })
    store.deleteByUids(trash, [3])
    expect(store.getMessageSummary(m.message.id)).toBeUndefined()
  })

  it('keeps non-Gmail deletes unchanged', () => {
    const other = store.addAccount({
      email: 'me@example.org',
      name: 'Me',
      provider: 'imap',
      authType: 'password',
      imap: { host: 'mail.example.org', port: 993, secure: true },
      smtp: { host: 'mail.example.org', port: 465, secure: true },
      username: 'me@example.org',
      password: 'x'
    })
    const [f] = store.replaceFolders(other.id, [
      { accountId: other.id, path: 'INBOX', name: 'INBOX', delimiter: '/', kind: 'inbox', synced: true }
    ])
    const m = store.upsertMessage({ ...msg(f!.id, 1, 'ignored'), accountId: other.id, gmMsgid: undefined, gmThrid: undefined })
    store.reconcileUids(f!.id, [], 1)
    expect(store.getMessageSummary(m.message.id)).toBeUndefined()
  })
})
