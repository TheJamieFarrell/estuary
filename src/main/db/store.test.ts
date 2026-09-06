import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Account, EmailAddress, Folder } from '@shared/types'
import type { MailStore, MessageUpsert } from '../contracts'
import { createMailStore } from './index'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 1, 9, 0, 0)

let dir: string
let store: MailStore
let account: Account
let folders: Record<string, Folder>

function addr(address: string, name?: string): EmailAddress {
  return name ? { name, address } : { address }
}

function msg(partial: Partial<MessageUpsert> & { folderId: string; uid: number }): MessageUpsert {
  return {
    accountId: account.id,
    references: [],
    subject: 'Subject',
    from: [addr('alice@example.com', 'Alice Smith')],
    to: [addr('me@example.com', 'Me')],
    cc: [],
    bcc: [],
    replyTo: [],
    date: T0,
    flags: { seen: false, flagged: false, answered: false, draft: false, forwarded: false },
    hasAttachments: false,
    size: 1000,
    ...partial
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'unimail-db-'))
  store = createMailStore()
  store.open(join(dir, 'mail.db'))

  account = store.addAccount({
    email: 'me@example.com',
    name: 'Me',
    provider: 'imap',
    authType: 'password',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    username: 'me@example.com',
    password: 'hunter2'
  })

  const list = store.replaceFolders(account.id, [
    { accountId: account.id, path: 'INBOX', name: 'Inbox', delimiter: '/', kind: 'inbox' },
    { accountId: account.id, path: 'Sent', name: 'Sent', delimiter: '/', kind: 'sent' },
    { accountId: account.id, path: 'Trash', name: 'Trash', delimiter: '/', kind: 'trash' },
    { accountId: account.id, path: 'Archive', name: 'Archive', delimiter: '/', kind: 'archive' }
  ])
  folders = Object.fromEntries(list.map((f) => [f.kind, f]))
})

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('accounts', () => {
  it('stores and reads back an account with its secret', () => {
    expect(store.listAccounts()).toHaveLength(1)
    expect(store.getAccount(account.id)?.email).toBe('me@example.com')
    expect(store.getAccountSecret(account.id)?.password).toBe('hunter2')
    expect(account.color).toMatch(/^#/)
  })

  it('patches an account without touching untouched fields', () => {
    const updated = store.updateAccount(account.id, { name: 'Me (work)', lastError: 'boom' })
    expect(updated.name).toBe('Me (work)')
    expect(updated.lastError).toBe('boom')
    expect(updated.imap.host).toBe('imap.example.com')
    expect(store.getAccountSecret(account.id)?.password).toBe('hunter2')
    store.updateAccount(account.id, { lastError: undefined })
  })

  it('stores oauth tokens encrypted and round-trips them', () => {
    store.setAccountOAuth(account.id, {
      provider: 'google',
      clientId: 'cid',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: T0,
      scope: 'https://mail.google.com/'
    })
    expect(store.getAccountSecret(account.id)?.oauth?.refreshToken).toBe('rt')
  })
})

describe('folders', () => {
  it('replaces the folder list and finds folders by path and kind', () => {
    expect(Object.keys(folders).sort()).toEqual(['archive', 'inbox', 'sent', 'trash'])
    expect(store.getFolderByPath(account.id, 'INBOX')?.id).toBe(folders.inbox?.id)
    expect(store.getFolderByKind(account.id, 'sent')?.path).toBe('Sent')
    expect(store.listFolders(account.id)).toHaveLength(4)
  })

  it('round-trips folder sync state', () => {
    const id = folders.inbox?.id as string
    store.setFolderSyncState(id, { uidValidity: 12, uidNext: 40, lowestUid: 1 })
    store.setFolderSyncState(id, { highestModseq: '99' })
    expect(store.getFolderSyncState(id)).toEqual({
      uidValidity: 12,
      uidNext: 40,
      highestModseq: '99',
      lowestUid: 1,
      lastFullFlagSyncAt: undefined
    })
  })
})

describe('messages, threading and listing', () => {
  it('upserts messages and threads replies together', () => {
    const inbox = folders.inbox?.id as string
    const results = store.upsertMessages([
      msg({
        folderId: inbox,
        uid: 1,
        messageIdHeader: 'root@example.com',
        subject: 'Project kickoff',
        snippet: 'Here is the plan',
        date: T0
      }),
      msg({
        folderId: inbox,
        uid: 2,
        messageIdHeader: 'reply@example.com',
        inReplyTo: 'root@example.com',
        references: ['root@example.com'],
        subject: 'Re: Project kickoff',
        snippet: 'Sounds good',
        from: [addr('bob@example.com', 'Bob Jones')],
        date: T0 + 60_000
      }),
      msg({
        folderId: inbox,
        uid: 3,
        messageIdHeader: 'invoice@example.com',
        subject: 'Invoice 42',
        snippet: 'Please find attached',
        from: [addr('billing@vendor.test', 'Vendor Billing')],
        hasAttachments: true,
        flags: { seen: false, flagged: true, answered: false, draft: false, forwarded: false },
        date: T0 + 2 * DAY
      })
    ])

    expect(results.map((r) => r.isNew)).toEqual([true, true, true])
    expect(results[0]?.message.threadId).toBe(results[1]?.message.threadId)
    expect(results[2]?.message.threadId).not.toBe(results[0]?.message.threadId)
  })

  it('is idempotent on re-upsert of the same (folder, uid)', () => {
    const inbox = folders.inbox?.id as string
    const again = store.upsertMessage(
      msg({ folderId: inbox, uid: 1, messageIdHeader: 'root@example.com', subject: 'Project kickoff' })
    )
    expect(again.isNew).toBe(false)
    expect(store.listUids(inbox)).toEqual([1, 2, 3])
  })

  it('lists threads newest first with aggregates', () => {
    const res = store.listMessages({ folderKind: 'inbox' })
    expect(res.threads).toHaveLength(2)
    expect(res.total).toBe(2)
    const [first, second] = res.threads
    expect(first?.subject).toBe('Invoice 42')
    expect(first?.hasAttachments).toBe(true)
    expect(first?.hasStarred).toBe(true)
    expect(second?.subject).toBe('Project kickoff')
    expect(second?.messageCount).toBe(2)
    expect(second?.unreadCount).toBe(2)
    expect(second?.messageIds).toHaveLength(2)
    expect(second?.folderKinds).toEqual(['inbox'])
    expect(second?.participants.map((p) => p.address)).toContain('bob@example.com')
  })

  it('filters by folder id and looks messages up by header id', () => {
    expect(store.listMessages({ folderId: folders.inbox?.id }).threads).toHaveLength(2)
    expect(store.listMessages({ folderId: folders.sent?.id }).threads).toHaveLength(0)
    expect(store.getMessageByHeaderId(account.id, '<root@example.com>')?.uid).toBe(1)
    expect(store.getMessageByHeaderId(account.id, 'missing@example.com')).toBeUndefined()
  })

  it('filters by unread, starred and attachments', () => {
    expect(store.listMessages({ unreadOnly: true }).threads).toHaveLength(2)
    expect(store.listMessages({ starredOnly: true }).threads).toHaveLength(1)
    expect(store.listMessages({ withAttachments: true }).threads).toHaveLength(1)
    expect(store.listMessages({ folderKind: 'sent' }).threads).toHaveLength(0)
    expect(store.listMessages({ accountId: 'nope' }).threads).toHaveLength(0)
  })

  it('paginates with an opaque cursor', () => {
    const page1 = store.listMessages({ folderKind: 'inbox', limit: 1 })
    expect(page1.threads).toHaveLength(1)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = store.listMessages({ folderKind: 'inbox', limit: 1, cursor: page1.nextCursor })
    expect(page2.threads).toHaveLength(1)
    expect(page2.threads[0]?.id).not.toBe(page1.threads[0]?.id)
    expect(page2.nextCursor).toBeUndefined()
  })

  it('counts unread mail per account and folder', () => {
    const counts = store.unreadCounts()
    expect(counts.inbox).toBe(3)
    expect(counts.byAccount[account.id]).toBe(3)
    expect(counts.byFolder[folders.inbox?.id as string]).toBe(3)
  })

  it('stores bodies separately and returns them with getMessage', () => {
    const target = store.getMessageByUid(folders.inbox?.id as string, 3) as { id: string }
    store.setMessageBody(target.id, {
      html: '<p>Invoice for <b>consulting</b> services</p>',
      text: 'Invoice for consulting services',
      headers: { 'list-unsubscribe': '<mailto:x@y>' },
      attachments: [
        { filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048, isInline: false, partId: '2' }
      ]
    })
    const full = store.getMessage(target.id)
    expect(full?.html).toContain('consulting')
    expect(full?.headers['list-unsubscribe']).toBe('<mailto:x@y>')
    expect(full?.attachments).toHaveLength(1)
    expect(full?.bodyFetched).toBe(true)
    expect(store.listMessagesWithoutBody(folders.inbox?.id as string, 10).map((m) => m.uid)).toEqual([2, 1])

    const attachment = full?.attachments[0]
    store.setAttachmentLocalPath(attachment?.id as string, 'C:/tmp/invoice.pdf')
    expect(store.getAttachment(attachment?.id as string)?.localPath).toBe('C:/tmp/invoice.pdf')
  })

  it('returns a full thread oldest first', () => {
    const thread = store.listMessages({ folderKind: 'inbox' }).threads.find((t) => t.messageCount === 2)
    const messages = store.getThread(thread?.id as string)
    expect(messages.map((m) => m.uid)).toEqual([1, 2])
    expect(store.getThreadSummary(thread?.id as string)?.messageCount).toBe(2)
  })
})

describe('search', () => {
  it('matches free text across subject and body', () => {
    expect(store.search({ q: 'kickoff' }).threads).toHaveLength(1)
    expect(store.search({ q: 'consulting' }).threads).toHaveLength(1)
    expect(store.search({ q: 'nonexistentterm' }).threads).toHaveLength(0)
  })

  it('supports from: and prefix matching', () => {
    expect(store.search({ q: 'from:bob' }).threads).toHaveLength(1)
    expect(store.search({ q: 'from:billing invoice' }).threads).toHaveLength(1)
    expect(store.search({ q: 'from:nobody' }).threads).toHaveLength(0)
  })

  it('supports operator-only queries', () => {
    expect(store.search({ q: 'has:attachment' }).threads).toHaveLength(1)
    expect(store.search({ q: 'is:starred' }).threads).toHaveLength(1)
    expect(store.search({ q: 'in:inbox' }).threads).toHaveLength(2)
  })

  it('supports date bounds and account scoping', () => {
    expect(store.search({ q: 'after:2026-09-02' }).threads).toHaveLength(1)
    expect(store.search({ q: 'kickoff', accountId: account.id }).threads).toHaveLength(1)
    expect(store.search({ q: 'kickoff', accountId: 'other' }).threads).toHaveLength(0)
  })

  it('never lets a hostile token become FTS syntax', () => {
    expect(() => store.search({ q: 'foo" OR bar' })).not.toThrow()
    expect(() => store.search({ q: '((' })).not.toThrow()
    expect(() => store.search({ q: 'NEAR/' })).not.toThrow()
  })
})

describe('flags, moves and deletes', () => {
  it('updates flags and thread aggregates', () => {
    const inbox = folders.inbox?.id as string
    store.updateFlags(inbox, 1, { seen: true })
    store.updateFlagsBulk([{ folderId: inbox, uid: 2, flags: { seen: true, answered: true } }])
    const thread = store.listMessages({ folderKind: 'inbox' }).threads.find((t) => t.messageCount === 2)
    expect(thread?.unreadCount).toBe(0)
    expect(store.unreadCounts().inbox).toBe(1)
    expect(store.listMessages({ unreadOnly: true }).threads).toHaveLength(1)
  })

  it('moves a message to trash and drops it out of the inbox view', () => {
    const inbox = folders.inbox?.id as string
    const target = store.getMessageByUid(inbox, 3) as { id: string; threadId: string }
    store.moveMessage(target.id, folders.trash?.id as string, 7)
    expect(store.listMessages({ folderKind: 'inbox' }).threads).toHaveLength(1)
    expect(store.listMessages({ folderKind: 'trash' }).threads).toHaveLength(1)
    const moved = store.getMessageSummary(target.id)
    expect(moved?.folderId).toBe(folders.trash?.id)
    expect(moved?.uid).toBe(7)
    expect(store.getThreadSummary(target.threadId)?.folderKinds).toEqual(['trash'])
  })

  it('assigns a placeholder uid when the server uid is unknown', () => {
    const trash = folders.trash?.id as string
    const target = store.getMessageByUid(trash, 7) as { id: string }
    store.moveMessage(target.id, folders.archive?.id as string)
    const moved = store.getMessageSummary(target.id)
    expect(moved?.folderId).toBe(folders.archive?.id)
    expect(moved?.uid).toBeLessThan(0)
    expect(store.listUids(folders.archive?.id as string)).toEqual([])

    // When the server later reports the moved message, it adopts the real uid instead of
    // creating a duplicate row.
    const adopted = store.upsertMessage(
      msg({
        folderId: folders.archive?.id as string,
        uid: 21,
        messageIdHeader: 'invoice@example.com',
        subject: 'Invoice 42'
      })
    )
    expect(adopted.isNew).toBe(false)
    expect(adopted.message.id).toBe(target.id)
    expect(store.listUids(folders.archive?.id as string)).toEqual([21])

    store.moveMessage(target.id, trash, 7)
  })

  it('deletes by uid and reconciles a uid listing', () => {
    const inbox = folders.inbox?.id as string
    store.upsertMessage(
      msg({ folderId: inbox, uid: 10, messageIdHeader: 'gone@example.com', subject: 'Temporary', date: T0 + 3 * DAY })
    )
    expect(store.listMessages({ folderKind: 'inbox' }).threads).toHaveLength(2)
    store.deleteByUids(inbox, [10])
    expect(store.listMessages({ folderKind: 'inbox' }).threads).toHaveLength(1)

    store.upsertMessage(
      msg({ folderId: inbox, uid: 11, messageIdHeader: 'stale@example.com', subject: 'Stale', date: T0 + 4 * DAY })
    )
    const { removed } = store.reconcileUids(inbox, [1, 2], 1)
    expect(removed).toBe(1)
    expect(store.listUids(inbox)).toEqual([1, 2])
  })

  it('clears a folder', () => {
    const archive = folders.archive?.id as string
    store.upsertMessage(msg({ folderId: archive, uid: 5, messageIdHeader: 'arch@example.com', subject: 'Archived' }))
    expect(store.listMessages({ folderKind: 'archive' }).threads).toHaveLength(1)
    store.clearFolder(archive)
    expect(store.listMessages({ folderKind: 'archive' }).threads).toHaveLength(0)
    expect(store.getFolderSyncState(archive)).toEqual({})
  })
})

describe('contacts, drafts, outbox, actions and settings', () => {
  it('suggests contacts by prefix ordered by frequency', () => {
    const hits = store.suggestContacts('ali', 5)
    expect(hits[0]?.address).toBe('alice@example.com')
    expect(hits[0]?.name).toBe('Alice Smith')
    expect(hits[0]?.count).toBeGreaterThan(0)
    expect(store.suggestContacts('Bob', 5).map((h) => h.address)).toEqual(['bob@example.com'])
    expect(store.suggestContacts('zzz', 5)).toEqual([])
    expect(store.suggestContacts('', 5).length).toBeGreaterThan(0)
  })

  it('saves, lists and deletes drafts', () => {
    const draft = store.saveDraft({
      accountId: account.id,
      to: [addr('bob@example.com')],
      cc: [],
      bcc: [],
      subject: 'Hi',
      html: '<p>Hi</p>',
      attachments: []
    })
    expect(draft.id).toBeTruthy()
    expect(store.listDrafts(account.id)).toHaveLength(1)
    const updated = store.saveDraft({ ...draft.payload, subject: 'Hi again' }, 12)
    expect(updated.id).toBe(draft.id)
    expect(updated.payload.subject).toBe('Hi again')
    expect(updated.remoteUid).toBe(12)
    store.deleteDraft(draft.id)
    expect(store.listDrafts()).toHaveLength(0)
  })

  it('queues pending actions and the outbox', () => {
    const action = store.enqueueAction({
      accountId: account.id,
      request: { action: 'markRead', messageIds: ['m1'] },
      targets: [{ messageId: 'm1', folderId: folders.inbox?.id as string, uid: 1 }]
    })
    expect(store.listPendingActions(account.id)).toHaveLength(1)
    store.failAction(action.id, 'offline')
    expect(store.listPendingActions(account.id)[0]?.attempts).toBe(1)
    expect(store.listPendingActions(account.id)[0]?.lastError).toBe('offline')
    store.completeAction(action.id)
    expect(store.listPendingActions(account.id)).toHaveLength(0)

    const item = store.enqueueOutbox({
      accountId: account.id,
      to: [addr('bob@example.com')],
      cc: [],
      bcc: [],
      subject: 'Later',
      html: '<p>Later</p>',
      attachments: []
    })
    expect(store.listOutbox(account.id)).toHaveLength(1)
    store.updateOutbox(item.id, { status: 'failed', attempts: 2, lastError: 'smtp down' })
    const stored = store.listOutbox()[0]
    expect(stored?.status).toBe('failed')
    expect(stored?.attempts).toBe(2)
    store.deleteOutbox(item.id)
    expect(store.listOutbox()).toHaveLength(0)
  })

  it('merges settings over the defaults', () => {
    expect(store.getSettings().theme).toBe('system')
    const next = store.setSettings({ theme: 'dark', oauthClients: { google: { clientId: 'g' } } })
    expect(next.theme).toBe('dark')
    expect(next.pollIntervalSec).toBe(300)
    store.setSettings({ notificationsEnabled: false })
    const merged = store.getSettings()
    expect(merged.theme).toBe('dark')
    expect(merged.notificationsEnabled).toBe(false)
    expect(merged.oauthClients.google?.clientId).toBe('g')
  })
})

describe('lifecycle', () => {
  it('survives a close and reopen', () => {
    const file = join(dir, 'reopen.db')
    const first = createMailStore()
    first.open(file)
    const acc = first.addAccount({
      email: 'x@y.z',
      name: 'X',
      provider: 'imap',
      authType: 'password',
      imap: { host: 'h', port: 993, secure: true },
      smtp: { host: 'h', port: 465, secure: true },
      username: 'x@y.z',
      password: randomUUID()
    })
    first.close()

    const second = createMailStore()
    second.open(file)
    expect(second.listAccounts().map((a) => a.id)).toEqual([acc.id])
    second.removeAccount(acc.id)
    expect(second.listAccounts()).toHaveLength(0)
    second.close()
  })

  it('throws a readable error when used before open', () => {
    expect(() => createMailStore().listAccounts()).toThrow(/not open/i)
  })
})
