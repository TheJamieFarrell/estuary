/**
 * SQLite-backed MailStore.
 *
 *   import { createMailStore } from './db'
 *   const store = createMailStore()
 *   store.open(paths.dbFile)   // AFTER app.whenReady(): safeStorage needs a ready app
 *
 * Everything is synchronous (better-sqlite3 / node:sqlite are both sync APIs), which keeps the
 * IPC handlers trivial. Thread aggregates are maintained as messages are written; recomputes are
 * batched per transaction.
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  Account,
  AccountInput,
  AppSettings,
  AttachmentMeta,
  ComposePayload,
  Draft,
  EmailAddress,
  Folder,
  FolderKind,
  MessageActionRequest,
  MessageFlags,
  MessageFull,
  MessageListQuery,
  MessageListResult,
  MessageSummary,
  OAuthTokens,
  ProviderId,
  AuthType,
  SearchQuery,
  ThreadSummary,
  UnreadCounts
} from '@shared/types'
import type {
  FolderSyncState,
  FolderUpsert,
  MailStore,
  MessageBody,
  MessageUpsert,
  OutboxItem,
  PendingAction
} from '../contracts'
import { log } from './log'
import { currentVersion, hasFts, migrate } from './schema'
import { decryptJson, decryptSecret, encryptJson, encryptSecret, isEncryptionAvailable } from './secrets'
import { parseSearchQuery } from './searchParser'
import { openDatabase, type SqlDatabase, type SqlParam, type SqlStatement } from './sqlite'
import {
  normaliseAddress,
  normaliseMessageId,
  normaliseSubject,
  pickMergeTarget,
  resolveThread,
  type ThreadLookups
} from './threading'

const ACCOUNT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16']
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_INDEXED_BODY_CHARS = 200_000
const SETTINGS_KEY = 'app'
const HIDDEN_KINDS: FolderKind[] = ['trash', 'spam']

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string
  email: string
  name: string
  provider: string
  auth_type: string
  imap_host: string
  imap_port: number
  imap_secure: number
  smtp_host: string
  smtp_port: number
  smtp_secure: number
  username: string
  color: string
  signature: string | null
  created_at: number
  last_sync_at: number | null
  last_error: string | null
  cache_limit: number
  enabled: number
  secret_enc: Uint8Array | null
  oauth_enc: Uint8Array | null
}

interface FolderRow {
  id: string
  account_id: string
  path: string
  name: string
  delimiter: string
  kind: string
  unread_count: number
  total_count: number
  synced: number
}

interface MessageRow {
  seq: number
  id: string
  account_id: string
  folder_id: string
  thread_id: string
  uid: number
  message_id_header: string | null
  in_reply_to: string | null
  references_json: string
  gm_thrid: string | null
  gm_msgid: string | null
  subject: string
  subject_norm: string
  from_json: string
  to_json: string
  cc_json: string
  bcc_json: string
  reply_to_json: string
  date: number
  internal_date: number | null
  snippet: string
  seen: number
  flagged: number
  answered: number
  draft: number
  forwarded: number
  has_attachments: number
  size: number
  labels_json: string
  body_fetched: number
  participants_norm: string
  created_at: number
}

interface ThreadRow {
  id: string
  account_id: string
  gm_thrid: string | null
  subject: string
  subject_norm: string
  last_date: number
  first_date: number
  message_count: number
  unread_count: number
  has_starred: number
  has_attachments: number
  has_draft: number
  participants_json: string
  snippet: string
  folder_kinds_json: string
}

interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  content_type: string
  size: number
  content_id: string | null
  is_inline: number
  part_id: string
  local_path: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function addresses(raw: string | null | undefined): EmailAddress[] {
  const parsed = jsonOr<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((a): a is EmailAddress => !!a && typeof a === 'object' && typeof (a as EmailAddress).address === 'string')
    .map((a) => (a.name ? { name: a.name, address: a.address } : { address: a.address }))
}

function addressKey(a: EmailAddress): string {
  return normaliseAddress(a.address)
}

function addressText(list: EmailAddress[]): string {
  return list.map((a) => `${a.name ?? ''} ${a.address}`.trim()).join(' ')
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function makeSnippet(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function encodeCursor(lastDate: number, id: string): string {
  return Buffer.from(JSON.stringify({ d: lastDate, i: id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): { d: number; i: string } | undefined {
  if (!cursor) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { d: number; i: string }
    if (typeof parsed?.d !== 'number' || typeof parsed?.i !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function flagsOf(row: MessageRow): MessageFlags {
  return {
    seen: !!row.seen,
    flagged: !!row.flagged,
    answered: !!row.answered,
    draft: !!row.draft,
    forwarded: !!row.forwarded
  }
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createMailStore(): MailStore {
  let db: SqlDatabase | null = null
  let ftsEnabled = false
  const stmts = new Map<string, SqlStatement>()

  function conn(): SqlDatabase {
    if (!db) throw new Error('Mail store is not open. Call store.open(dbPath) first.')
    return db
  }

  function q(sql: string): SqlStatement {
    let stmt = stmts.get(sql)
    if (!stmt) {
      stmt = conn().prepare(sql)
      stmts.set(sql, stmt)
    }
    return stmt
  }

  const run = (sql: string, ...params: SqlParam[]): void => {
    q(sql).run(...params)
  }

  // -- accounts -------------------------------------------------------------

  function toAccount(r: AccountRow): Account {
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      provider: r.provider as ProviderId,
      authType: r.auth_type as AuthType,
      imap: { host: r.imap_host, port: r.imap_port, secure: !!r.imap_secure },
      smtp: { host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure },
      username: r.username,
      color: r.color,
      signature: r.signature ?? undefined,
      createdAt: r.created_at,
      lastSyncAt: r.last_sync_at ?? undefined,
      lastError: r.last_error ?? undefined,
      cacheLimit: r.cache_limit,
      enabled: !!r.enabled
    }
  }

  function accountRow(id: string): AccountRow | undefined {
    return q('SELECT * FROM accounts WHERE id = ?').get<AccountRow>(id)
  }

  function requireAccount(id: string): AccountRow {
    const row = accountRow(id)
    if (!row) throw new Error(`Account ${id} not found`)
    return row
  }

  // -- folders --------------------------------------------------------------

  function toFolder(r: FolderRow): Folder {
    return {
      id: r.id,
      accountId: r.account_id,
      path: r.path,
      name: r.name,
      delimiter: r.delimiter,
      kind: r.kind as FolderKind,
      unreadCount: r.unread_count,
      totalCount: r.total_count,
      synced: !!r.synced
    }
  }

  function folderRow(id: string): FolderRow | undefined {
    return q('SELECT * FROM folders WHERE id = ?').get<FolderRow>(id)
  }

  function requireFolder(id: string): FolderRow {
    const row = folderRow(id)
    if (!row) throw new Error(`Folder ${id} not found`)
    return row
  }

  // -- messages -------------------------------------------------------------

  function toSummary(r: MessageRow): MessageSummary {
    return {
      id: r.id,
      accountId: r.account_id,
      folderId: r.folder_id,
      threadId: r.thread_id,
      uid: r.uid,
      messageIdHeader: r.message_id_header ?? undefined,
      subject: r.subject,
      from: addresses(r.from_json),
      to: addresses(r.to_json),
      cc: addresses(r.cc_json),
      bcc: addresses(r.bcc_json),
      replyTo: addresses(r.reply_to_json),
      date: r.date,
      snippet: r.snippet,
      flags: flagsOf(r),
      hasAttachments: !!r.has_attachments,
      size: r.size,
      labels: jsonOr<string[]>(r.labels_json, []),
      bodyFetched: !!r.body_fetched
    }
  }

  function toAttachment(r: AttachmentRow): AttachmentMeta {
    return {
      id: r.id,
      messageId: r.message_id,
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
      contentId: r.content_id ?? undefined,
      isInline: !!r.is_inline,
      partId: r.part_id,
      localPath: r.local_path ?? undefined
    }
  }

  function toFull(r: MessageRow): MessageFull {
    const body = q('SELECT html, text, headers_json FROM message_bodies WHERE message_id = ?').get<{
      html: string | null
      text: string | null
      headers_json: string
    }>(r.id)
    const atts = q('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid').all<AttachmentRow>(r.id)
    return {
      ...toSummary(r),
      html: body?.html ?? undefined,
      text: body?.text ?? undefined,
      inReplyTo: r.in_reply_to ?? undefined,
      references: jsonOr<string[]>(r.references_json, []),
      attachments: atts.map(toAttachment),
      headers: jsonOr<Record<string, string>>(body?.headers_json, {})
    }
  }

  // -- FTS ------------------------------------------------------------------

  function indexMessage(seq: number, subject: string, from: EmailAddress[], to: EmailAddress[], body: string): void {
    if (!ftsEnabled) return
    run('DELETE FROM messages_fts WHERE rowid = ?', seq)
    q('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(
      seq,
      subject,
      addressText(from),
      addressText(to),
      body.slice(0, MAX_INDEXED_BODY_CHARS)
    )
  }

  function reindexMessage(messageId: string): void {
    if (!ftsEnabled) return
    const row = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(messageId)
    if (!row) return
    const body = q('SELECT html, text FROM message_bodies WHERE message_id = ?').get<{
      html: string | null
      text: string | null
    }>(messageId)
    const text = body?.text ? body.text : body?.html ? htmlToText(body.html) : row.snippet
    indexMessage(
      row.seq,
      row.subject,
      addresses(row.from_json),
      [...addresses(row.to_json), ...addresses(row.cc_json)],
      text ?? ''
    )
  }

  // -- contacts -------------------------------------------------------------

  function recordContact(a: EmailAddress, at: number): void {
    const address = normaliseAddress(a.address)
    if (!address || !address.includes('@')) return
    q(
      `INSERT INTO contacts (address, name, count, last_seen) VALUES (?, ?, 1, ?)
       ON CONFLICT(address) DO UPDATE SET
         count = contacts.count + 1,
         last_seen = MAX(contacts.last_seen, excluded.last_seen),
         name = COALESCE(NULLIF(excluded.name, ''), contacts.name)`
    ).run(address, a.name ?? '', at)
  }

  // -- thread aggregates ----------------------------------------------------

  function recomputeThread(threadId: string): void {
    const agg = q(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread,
              MAX(date) AS last_date,
              MIN(date) AS first_date,
              MAX(flagged) AS starred,
              MAX(has_attachments) AS att,
              MAX(draft) AS has_draft
       FROM messages WHERE thread_id = ?`
    ).get<{
      n: number
      unread: number | null
      last_date: number | null
      first_date: number | null
      starred: number | null
      att: number | null
      has_draft: number | null
    }>(threadId)

    if (!agg || Number(agg.n) === 0) {
      run('DELETE FROM threads WHERE id = ?', threadId)
      return
    }

    const kinds = q(
      `SELECT DISTINCT f.kind AS kind FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.thread_id = ?`
    ).all<{ kind: string }>(threadId)

    const oldest = q('SELECT subject FROM messages WHERE thread_id = ? ORDER BY date ASC, seq ASC LIMIT 1').get<{
      subject: string
    }>(threadId)
    const newest = q(
      'SELECT snippet, gm_thrid, subject_norm FROM messages WHERE thread_id = ? ORDER BY date DESC, seq DESC LIMIT 1'
    ).get<{ snippet: string; gm_thrid: string | null; subject_norm: string }>(threadId)

    const recent = q(
      'SELECT from_json, to_json, cc_json FROM messages WHERE thread_id = ? ORDER BY date DESC, seq DESC LIMIT 50'
    ).all<{ from_json: string; to_json: string; cc_json: string }>(threadId)

    const participants: EmailAddress[] = []
    const seenAddresses = new Set<string>()
    for (const pass of [0, 1]) {
      for (const row of recent) {
        const list = pass === 0 ? addresses(row.from_json) : [...addresses(row.to_json), ...addresses(row.cc_json)]
        for (const a of list) {
          const key = addressKey(a)
          if (!key || seenAddresses.has(key)) continue
          seenAddresses.add(key)
          participants.push(a)
        }
      }
    }

    q(
      `UPDATE threads SET
         subject = ?, subject_norm = ?, last_date = ?, first_date = ?, message_count = ?, unread_count = ?,
         has_starred = ?, has_attachments = ?, has_draft = ?, participants_json = ?, snippet = ?,
         folder_kinds_json = ?, gm_thrid = COALESCE(?, gm_thrid)
       WHERE id = ?`
    ).run(
      oldest?.subject ?? '',
      newest?.subject_norm ?? normaliseSubject(oldest?.subject ?? ''),
      Number(agg.last_date ?? 0),
      Number(agg.first_date ?? 0),
      Number(agg.n),
      Number(agg.unread ?? 0),
      Number(agg.starred ?? 0) ? 1 : 0,
      Number(agg.att ?? 0) ? 1 : 0,
      Number(agg.has_draft ?? 0) ? 1 : 0,
      JSON.stringify(participants.slice(0, 25)),
      newest?.snippet ?? '',
      JSON.stringify(kinds.map((k) => k.kind)),
      newest?.gm_thrid ?? null,
      threadId
    )
  }

  function recomputeThreads(ids: Iterable<string>): void {
    for (const id of new Set(ids)) recomputeThread(id)
  }

  /**
   * Rows that vanished from a folder on the server. On Gmail a message leaving INBOX (archived)
   * still exists in All Mail, so instead of deleting it we park it in the All Mail folder on a
   * placeholder uid; the next All Mail sync adopts the placeholder (see upsertOne). Messages
   * leaving Trash/Spam or All Mail itself are really gone. Returns the number of rows affected.
   */
  function removeOrDemote(folderId: string, where: string, ...params: SqlParam[]): number {
    const folder = folderRow(folderId)
    const allFolder =
      folder && folder.kind !== 'all' && folder.kind !== 'trash' && folder.kind !== 'spam'
        ? q("SELECT id FROM folders WHERE account_id = ? AND kind = 'all' LIMIT 1").get<{ id: string }>(folder.account_id)
        : undefined
    let affected = 0
    if (allFolder) {
      const rows = q(`SELECT id, gm_msgid FROM messages WHERE ${where}`).all<{ id: string; gm_msgid: string | null }>(...params)
      for (const row of rows) {
        if (!row.gm_msgid) continue
        const dup = q('SELECT id FROM messages WHERE account_id = ? AND gm_msgid = ? AND id <> ? LIMIT 1').get<{ id: string }>(
          folder!.account_id,
          row.gm_msgid,
          row.id
        )
        if (dup) continue // another folder still holds it; plain delete below is right
        const min = q('SELECT MIN(uid) AS m FROM messages WHERE folder_id = ?').get<{ m: number | null }>(allFolder.id)
        const uid = Math.min(-1, Number(min?.m ?? 0) - 1)
        run('UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?', allFolder.id, uid, row.id)
        affected += 1
      }
    }
    const res = q(`DELETE FROM messages WHERE ${where}`).run(...params) as { changes?: number | bigint }
    return affected + Number(res?.changes ?? 0)
  }

  function threadIdsForMessages(where: string, ...params: SqlParam[]): string[] {
    return q(`SELECT DISTINCT thread_id FROM messages WHERE ${where}`)
      .all<{ thread_id: string }>(...params)
      .map((r) => r.thread_id)
  }

  // -- threading ------------------------------------------------------------

  function lookupsFor(accountId: string): ThreadLookups {
    return {
      byGmThrid(gmThrid) {
        const row = q('SELECT id FROM threads WHERE account_id = ? AND gm_thrid = ? LIMIT 1').get<{ id: string }>(
          accountId,
          gmThrid
        )
        return row?.id
      },
      byMessageIds(ids) {
        if (ids.length === 0) return []
        const rows = q(
          `SELECT DISTINCT thread_id FROM messages
           WHERE account_id = ? AND message_id_header IN (${placeholders(ids.length)})`
        ).all<{ thread_id: string }>(accountId, ...ids)
        return rows.map((r) => r.thread_id)
      },
      byReferencing(messageId) {
        const rows = q(
          'SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND in_reply_to = ?'
        ).all<{ thread_id: string }>(accountId, messageId)
        return rows.map((r) => r.thread_id)
      },
      bySubject(subjectNorm, fromDate, toDate) {
        if (!subjectNorm) return []
        const rows = q(
          `SELECT id, participants_json, last_date, first_date FROM threads
           WHERE account_id = ? AND subject_norm = ? AND first_date <= ? AND last_date >= ?
           ORDER BY last_date DESC LIMIT 25`
        ).all<{ id: string; participants_json: string; last_date: number; first_date: number }>(
          accountId,
          subjectNorm,
          toDate,
          fromDate
        )
        return rows.map((r) => ({
          threadId: r.id,
          participants: addresses(r.participants_json).map((a) => a.address),
          lastDate: r.last_date,
          firstDate: r.first_date
        }))
      }
    }
  }

  function mergeThreads(threadIds: string[]): string {
    const rows = q(
      `SELECT id, message_count, first_date FROM threads WHERE id IN (${placeholders(threadIds.length)})`
    ).all<{ id: string; message_count: number; first_date: number }>(...threadIds)
    if (rows.length === 0) throw new Error('mergeThreads: no threads found')
    const { keep, merge } = pickMergeTarget(
      rows.map((r) => ({ id: r.id, messageCount: r.message_count, firstDate: r.first_date }))
    )
    for (const other of merge) {
      run('UPDATE messages SET thread_id = ? WHERE thread_id = ?', keep, other)
      run('DELETE FROM threads WHERE id = ?', other)
    }
    return keep
  }

  function createThread(accountId: string, subject: string, subjectNorm: string, gmThrid?: string): string {
    const id = randomUUID()
    q(
      `INSERT INTO threads (id, account_id, gm_thrid, subject, subject_norm, last_date, first_date)
       VALUES (?, ?, ?, ?, ?, 0, 0)`
    ).run(id, accountId, gmThrid ?? null, subject, subjectNorm)
    return id
  }

  // -- upsert ---------------------------------------------------------------

  function writeAttachments(messageId: string, list: MessageBody['attachments']): boolean {
    run('DELETE FROM attachments WHERE message_id = ?', messageId)
    for (const a of list ?? []) {
      q(
        `INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, is_inline, part_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        messageId,
        a.filename ?? '',
        a.contentType ?? 'application/octet-stream',
        a.size ?? 0,
        a.contentId ?? null,
        a.isInline ? 1 : 0,
        a.partId ?? ''
      )
    }
    return (list ?? []).some((a) => !a.isInline)
  }

  function storeBody(messageId: string, body: MessageBody): void {
    const text = body.text ?? (body.html ? htmlToText(body.html) : '')
    q(
      `INSERT INTO message_bodies (message_id, html, text, headers_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         html = excluded.html, text = excluded.text, headers_json = excluded.headers_json,
         updated_at = excluded.updated_at`
    ).run(messageId, body.html ?? null, body.text ?? null, JSON.stringify(body.headers ?? {}), Date.now())

    const hasRealAttachments = writeAttachments(messageId, body.attachments ?? [])
    const current = q('SELECT snippet, has_attachments FROM messages WHERE id = ?').get<{
      snippet: string
      has_attachments: number
    }>(messageId)
    // A zero-width space is the "checked, nothing to show" marker left by the snippet backfill;
    // a real body always wins over it.
    const existingSnippet = (current?.snippet ?? '').replace(/​/g, '').trim()
    const snippet = existingSnippet.length > 0 ? current!.snippet : makeSnippet(text)
    run(
      'UPDATE messages SET body_fetched = 1, snippet = ?, has_attachments = ? WHERE id = ?',
      snippet,
      hasRealAttachments || !!current?.has_attachments ? 1 : 0,
      messageId
    )
    reindexMessage(messageId)
  }

  function upsertOne(msg: MessageUpsert, dirty: Set<string>): { message: MessageSummary; isNew: boolean } {
    const folder = requireFolder(msg.folderId)
    const accountId = msg.accountId || folder.account_id
    const subject = msg.subject ?? ''
    const subjectNorm = normaliseSubject(subject)
    const from = msg.from ?? []
    const to = msg.to ?? []
    const cc = msg.cc ?? []
    const headerId = normaliseMessageId(msg.messageIdHeader) || null
    const date = Number.isFinite(msg.date) ? msg.date : (msg.internalDate ?? Date.now())

    let existing = q('SELECT * FROM messages WHERE folder_id = ? AND uid = ?').get<MessageRow>(
      msg.folderId,
      msg.uid
    )
    if (!existing && headerId && msg.uid > 0) {
      // A local move parked this message on a placeholder uid; adopt the real one instead of
      // inserting a duplicate when the server reports it.
      const placeholder = q(
        'SELECT * FROM messages WHERE folder_id = ? AND message_id_header = ? AND uid < 0 ORDER BY uid DESC LIMIT 1'
      ).get<MessageRow>(msg.folderId, headerId)
      if (placeholder) {
        run('UPDATE messages SET uid = ? WHERE id = ?', msg.uid, placeholder.id)
        existing = { ...placeholder, uid: msg.uid }
      }
    }

    if (!existing && msg.gmMsgid) {
      // Gmail: one physical message, many labels. "[Gmail]/All Mail" mirrors every other folder, so a
      // message must never exist as two rows. The copy in a real folder (INBOX, Sent, ...) wins.
      const twin = q(
        `SELECT m.*, f.kind AS twin_kind FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND m.gm_msgid = ? AND m.folder_id <> ? LIMIT 1`
      ).get<MessageRow & { twin_kind: string }>(accountId, msg.gmMsgid, msg.folderId)
      if (twin) {
        if (folder.kind === 'all') {
          // The All Mail mirror of a message we already hold elsewhere: nothing to add.
          return { message: toSummary(twin), isNew: false }
        }
        if (twin.twin_kind === 'all') {
          // Previously only known from All Mail (archived); it is now in a real folder, so move it there.
          run('UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?', msg.folderId, msg.uid, twin.id)
          existing = { ...twin, folder_id: msg.folderId, uid: msg.uid }
        }
      }
    }

    if (existing) {
      q(
        `UPDATE messages SET
           message_id_header = COALESCE(?, message_id_header),
           in_reply_to = COALESCE(?, in_reply_to),
           references_json = ?, gm_thrid = COALESCE(?, gm_thrid), gm_msgid = COALESCE(?, gm_msgid),
           subject = ?, subject_norm = ?, from_json = ?, to_json = ?, cc_json = ?, bcc_json = ?,
           reply_to_json = ?, date = ?, internal_date = COALESCE(?, internal_date),
           snippet = CASE WHEN ? <> '' THEN ? ELSE snippet END,
           seen = ?, flagged = ?, answered = ?, draft = ?, forwarded = ?,
           has_attachments = ?, size = ?, labels_json = ?, participants_norm = ?
         WHERE id = ?`
      ).run(
        headerId,
        normaliseMessageId(msg.inReplyTo) || null,
        JSON.stringify(msg.references ?? []),
        msg.gmThrid ?? null,
        msg.gmMsgid ?? null,
        subject,
        subjectNorm,
        JSON.stringify(from),
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(msg.bcc ?? []),
        JSON.stringify(msg.replyTo ?? []),
        date,
        msg.internalDate ?? null,
        msg.snippet ?? '',
        msg.snippet ?? '',
        msg.flags?.seen ? 1 : 0,
        msg.flags?.flagged ? 1 : 0,
        msg.flags?.answered ? 1 : 0,
        msg.flags?.draft ? 1 : 0,
        msg.flags?.forwarded ? 1 : 0,
        msg.hasAttachments ? 1 : 0,
        msg.size ?? 0,
        JSON.stringify(msg.labels ?? []),
        [...from, ...to, ...cc].map(addressKey).join(' '),
        existing.id
      )
      if (msg.body) storeBody(existing.id, msg.body)
      else reindexMessage(existing.id)
      dirty.add(existing.thread_id)
      const updated = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(existing.id) as MessageRow
      return { message: toSummary(updated), isNew: false }
    }

    // New message: work out the thread.
    const resolution = resolveThread(
      {
        accountId,
        messageIdHeader: msg.messageIdHeader,
        inReplyTo: msg.inReplyTo,
        references: msg.references ?? [],
        gmThrid: msg.gmThrid,
        subject,
        participants: [...from, ...to, ...cc].map((a) => a.address),
        date
      },
      lookupsFor(accountId)
    )

    let threadId: string
    if (resolution.threadIds.length === 0) {
      threadId = createThread(accountId, subject, resolution.subjectNorm, msg.gmThrid)
    } else if (resolution.threadIds.length === 1) {
      threadId = resolution.threadIds[0] as string
    } else {
      threadId = mergeThreads(resolution.threadIds)
      for (const id of resolution.threadIds) if (id !== threadId) dirty.delete(id)
    }

    const id = randomUUID()
    const res = q(
      `INSERT INTO messages (
         id, account_id, folder_id, thread_id, uid, message_id_header, in_reply_to, references_json,
         gm_thrid, gm_msgid, subject, subject_norm, from_json, to_json, cc_json, bcc_json, reply_to_json,
         date, internal_date, snippet, seen, flagged, answered, draft, forwarded, has_attachments, size,
         labels_json, body_fetched, participants_norm, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      accountId,
      msg.folderId,
      threadId,
      msg.uid,
      headerId,
      normaliseMessageId(msg.inReplyTo) || null,
      JSON.stringify(msg.references ?? []),
      msg.gmThrid ?? null,
      msg.gmMsgid ?? null,
      subject,
      subjectNorm,
      JSON.stringify(from),
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(msg.bcc ?? []),
      JSON.stringify(msg.replyTo ?? []),
      date,
      msg.internalDate ?? null,
      msg.snippet ?? '',
      msg.flags?.seen ? 1 : 0,
      msg.flags?.flagged ? 1 : 0,
      msg.flags?.answered ? 1 : 0,
      msg.flags?.draft ? 1 : 0,
      msg.flags?.forwarded ? 1 : 0,
      msg.hasAttachments ? 1 : 0,
      msg.size ?? 0,
      JSON.stringify(msg.labels ?? []),
      [...from, ...to, ...cc].map(addressKey).join(' '),
      Date.now()
    )

    indexMessage(res.lastInsertRowid, subject, from, [...to, ...cc], msg.snippet ?? '')
    if (msg.body) storeBody(id, msg.body)

    for (const a of from) recordContact(a, date)
    if (folder.kind === 'sent' || folder.kind === 'drafts') {
      for (const a of [...to, ...cc]) recordContact(a, date)
    }

    dirty.add(threadId)
    const inserted = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(id) as MessageRow
    return { message: toSummary(inserted), isNew: true }
  }

  // -- list / search --------------------------------------------------------

  function messageIdsByThread(threadIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (threadIds.length === 0) return map
    const rows = q(
      `SELECT thread_id, id FROM messages WHERE thread_id IN (${placeholders(threadIds.length)})
       ORDER BY date ASC, seq ASC`
    ).all<{ thread_id: string; id: string }>(...threadIds)
    for (const row of rows) {
      const list = map.get(row.thread_id)
      if (list) list.push(row.id)
      else map.set(row.thread_id, [row.id])
    }
    return map
  }

  function toThreadSummaries(rows: ThreadRow[]): ThreadSummary[] {
    const ids = messageIdsByThread(rows.map((r) => r.id))
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      subject: r.subject,
      participants: addresses(r.participants_json),
      lastDate: r.last_date,
      messageCount: r.message_count,
      unreadCount: r.unread_count,
      hasStarred: !!r.has_starred,
      hasAttachments: !!r.has_attachments,
      snippet: r.snippet,
      folderKinds: jsonOr<string[]>(r.folder_kinds_json, []) as FolderKind[],
      messageIds: ids.get(r.id) ?? [],
      hasDraft: !!r.has_draft
    }))
  }

  function threadFilters(query: MessageListQuery): { sql: string[]; params: SqlParam[] } {
    const sql: string[] = []
    const params: SqlParam[] = []

    if (query.accountId) {
      sql.push('t.account_id = ?')
      params.push(query.accountId)
    }
    if (query.folderId) {
      sql.push('EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder_id = ?)')
      params.push(query.folderId)
    } else if (query.folderKind) {
      sql.push(
        `EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
                 WHERE m.thread_id = t.id AND f.kind = ?)`
      )
      params.push(query.folderKind)
      if (query.folderKind === 'inbox') {
        // A thread whose only remaining copies are in Trash/Spam must not show in the inbox.
        sql.push(
          `EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
                   WHERE m.thread_id = t.id AND f.kind NOT IN (${placeholders(HIDDEN_KINDS.length)}))`
        )
        params.push(...HIDDEN_KINDS)
      }
    }
    if (query.unreadOnly) sql.push('t.unread_count > 0')
    if (query.starredOnly) sql.push('t.has_starred = 1')
    if (query.withAttachments) sql.push('t.has_attachments = 1')
    return { sql, params }
  }

  function pageThreads(
    baseSql: string[],
    baseParams: SqlParam[],
    join: string,
    joinParams: SqlParam[],
    limitRaw: number | undefined,
    cursor: string | undefined,
    wantTotal: boolean
  ): MessageListResult {
    const limit = Math.min(Math.max(Number(limitRaw) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const where = [...baseSql]
    const params: SqlParam[] = [...joinParams, ...baseParams]
    const pos = decodeCursor(cursor)
    if (pos) {
      where.push('(t.last_date < ? OR (t.last_date = ? AND t.id < ?))')
      params.push(pos.d, pos.d, pos.i)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = q(
      `SELECT t.* FROM threads t ${join} ${whereSql} ORDER BY t.last_date DESC, t.id DESC LIMIT ?`
    ).all<ThreadRow>(...params, limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const result: MessageListResult = { threads: toThreadSummaries(page) }
    const last = page[page.length - 1]
    if (hasMore && last) result.nextCursor = encodeCursor(last.last_date, last.id)

    if (wantTotal && !pos) {
      const countWhere = baseSql.length > 0 ? `WHERE ${baseSql.join(' AND ')}` : ''
      const total = q(`SELECT COUNT(*) AS n FROM threads t ${join} ${countWhere}`).get<{ n: number }>(
        ...joinParams,
        ...baseParams
      )
      result.total = Number(total?.n ?? 0)
    }
    return result
  }

  // -- settings -------------------------------------------------------------

  function readSettings(): AppSettings {
    const row = q('SELECT value_json FROM settings WHERE key = ?').get<{ value_json: string }>(SETTINGS_KEY)
    const stored = jsonOr<Partial<AppSettings>>(row?.value_json, {})
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      oauthClients: { ...DEFAULT_SETTINGS.oauthClients, ...(stored.oauthClients ?? {}) }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const store: MailStore = {
    open(dbPath: string): void {
      if (db) return
      db = openDatabase(dbPath)
      stmts.clear()
      const before = currentVersion(db)
      const version = migrate(db)
      ftsEnabled = hasFts(db)
      if (before > 0 && before < 2) {
        // Migration 2 removed duplicate rows; thread counters must be rebuilt once.
        const ids = q('SELECT id FROM threads').all<{ id: string }>().map((r) => r.id)
        conn().transaction(() => recomputeThreads(ids))()
        log.info(`rebuilt ${ids.length} thread summaries after migration`)
      }
      log.info(
        `store open: schema v${version}, fts=${ftsEnabled ? 'on' : 'off'}, ` +
          `secrets=${isEncryptionAvailable() ? 'safeStorage' : 'PLAINTEXT (safeStorage unavailable)'}`
      )
    },

    close(): void {
      stmts.clear()
      db?.close()
      db = null
    },

    // Accounts --------------------------------------------------------------

    listAccounts(): Account[] {
      return q('SELECT * FROM accounts ORDER BY sort_order ASC, created_at ASC')
        .all<AccountRow>()
        .map(toAccount)
    },

    getAccount(id: string): Account | undefined {
      const row = accountRow(id)
      return row ? toAccount(row) : undefined
    },

    addAccount(input: AccountInput): Account {
      const id = randomUUID()
      const count = Number(q('SELECT COUNT(*) AS n FROM accounts').get<{ n: number }>()?.n ?? 0)
      const color = input.color ?? (ACCOUNT_COLORS[count % ACCOUNT_COLORS.length] as string)
      q(
        `INSERT INTO accounts (
           id, email, name, provider, auth_type, imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_secure, username, color, signature, created_at,
           cache_limit, enabled, sort_order, secret_enc, oauth_enc
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        id,
        input.email,
        input.name ?? '',
        input.provider,
        input.authType,
        input.imap?.host ?? '',
        input.imap?.port ?? 993,
        input.imap?.secure ? 1 : 0,
        input.smtp?.host ?? '',
        input.smtp?.port ?? 465,
        input.smtp?.secure ? 1 : 0,
        input.username ?? input.email,
        color,
        input.signature ?? null,
        Date.now(),
        input.cacheLimit ?? 5000,
        count,
        input.password ? encryptSecret(input.password) : null,
        input.oauth ? encryptJson(input.oauth) : null
      )
      return toAccount(requireAccount(id))
    },

    updateAccount(id, patch): Account {
      requireAccount(id)
      const sets: string[] = []
      const params: SqlParam[] = []
      const set = (column: string, value: SqlParam): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.email !== undefined) set('email', patch.email)
      if (patch.name !== undefined) set('name', patch.name)
      if (patch.provider !== undefined) set('provider', patch.provider)
      if (patch.authType !== undefined) set('auth_type', patch.authType)
      if (patch.imap) {
        set('imap_host', patch.imap.host)
        set('imap_port', patch.imap.port)
        set('imap_secure', patch.imap.secure ? 1 : 0)
      }
      if (patch.smtp) {
        set('smtp_host', patch.smtp.host)
        set('smtp_port', patch.smtp.port)
        set('smtp_secure', patch.smtp.secure ? 1 : 0)
      }
      if (patch.username !== undefined) set('username', patch.username)
      if (patch.color !== undefined) set('color', patch.color)
      if (patch.signature !== undefined) set('signature', patch.signature)
      if (patch.cacheLimit !== undefined) set('cache_limit', patch.cacheLimit)
      if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0)
      if (patch.lastSyncAt !== undefined) set('last_sync_at', patch.lastSyncAt)
      // `lastError: undefined` means "clear it" (a successful sync), so test key presence, not value.
      if ('lastError' in patch) set('last_error', patch.lastError ?? null)
      if (patch.password !== undefined) set('secret_enc', patch.password ? encryptSecret(patch.password) : null)
      if (patch.oauth !== undefined) set('oauth_enc', patch.oauth ? encryptJson(patch.oauth) : null)
      if (sets.length > 0) {
        q(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      }
      return toAccount(requireAccount(id))
    },

    removeAccount(id: string): void {
      conn().transaction(() => {
        run('DELETE FROM accounts WHERE id = ?', id)
        run('DELETE FROM threads WHERE account_id = ?', id)
      })()
    },

    getAccountSecret(id: string): { password?: string; oauth?: OAuthTokens } | undefined {
      const row = accountRow(id)
      if (!row) return undefined
      const password = decryptSecret(row.secret_enc)
      const oauth = decryptJson<OAuthTokens>(row.oauth_enc)
      return { password, oauth }
    },

    setAccountOAuth(id: string, tokens: OAuthTokens): void {
      requireAccount(id)
      run('UPDATE accounts SET oauth_enc = ? WHERE id = ?', encryptJson(tokens), id)
    },

    // Folders ---------------------------------------------------------------

    listFolders(accountId?: string): Folder[] {
      const rows = accountId
        ? q('SELECT * FROM folders WHERE account_id = ? ORDER BY kind, path').all<FolderRow>(accountId)
        : q('SELECT * FROM folders ORDER BY account_id, kind, path').all<FolderRow>()
      return rows.map(toFolder)
    },

    getFolder(id: string): Folder | undefined {
      const row = folderRow(id)
      return row ? toFolder(row) : undefined
    },

    getFolderByPath(accountId: string, path: string): Folder | undefined {
      const row = q('SELECT * FROM folders WHERE account_id = ? AND path = ?').get<FolderRow>(accountId, path)
      return row ? toFolder(row) : undefined
    },

    getFolderByKind(accountId: string, kind: FolderKind): Folder | undefined {
      const row = q('SELECT * FROM folders WHERE account_id = ? AND kind = ? ORDER BY path LIMIT 1').get<FolderRow>(
        accountId,
        kind
      )
      return row ? toFolder(row) : undefined
    },

    replaceFolders(accountId: string, folders: FolderUpsert[]): Folder[] {
      requireAccount(accountId)
      conn().transaction(() => {
        const keep = new Set(folders.map((f) => f.path))
        for (const existing of q('SELECT * FROM folders WHERE account_id = ?').all<FolderRow>(accountId)) {
          if (keep.has(existing.path)) continue
          const threads = threadIdsForMessages('folder_id = ?', existing.id)
          run('DELETE FROM folders WHERE id = ?', existing.id)
          recomputeThreads(threads)
        }
        for (const f of folders) {
          q(
            `INSERT INTO folders (id, account_id, path, name, delimiter, kind, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, path) DO UPDATE SET
               name = excluded.name, delimiter = excluded.delimiter, kind = excluded.kind,
               synced = excluded.synced`
          ).run(randomUUID(), accountId, f.path, f.name, f.delimiter ?? '/', f.kind, f.synced === false ? 0 : 1)
        }
      })()
      return store.listFolders(accountId)
    },

    updateFolderCounts(folderId, counts): void {
      const sets: string[] = []
      const params: SqlParam[] = []
      if (counts.unreadCount !== undefined) {
        sets.push('unread_count = ?')
        params.push(counts.unreadCount)
      }
      if (counts.totalCount !== undefined) {
        sets.push('total_count = ?')
        params.push(counts.totalCount)
      }
      if (sets.length === 0) return
      q(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params, folderId)
    },

    getFolderSyncState(folderId: string): FolderSyncState {
      const row = q('SELECT * FROM folder_sync_state WHERE folder_id = ?').get<{
        uid_validity: number | null
        uid_next: number | null
        highest_modseq: string | null
        lowest_uid: number | null
        last_full_flag_sync_at: number | null
      }>(folderId)
      if (!row) return {}
      return {
        uidValidity: row.uid_validity ?? undefined,
        uidNext: row.uid_next ?? undefined,
        highestModseq: row.highest_modseq ?? undefined,
        lowestUid: row.lowest_uid ?? undefined,
        lastFullFlagSyncAt: row.last_full_flag_sync_at ?? undefined
      }
    },

    setFolderSyncState(folderId: string, state: FolderSyncState): void {
      requireFolder(folderId)
      const current = store.getFolderSyncState(folderId)
      const merged = { ...current, ...state }
      q(
        `INSERT INTO folder_sync_state (folder_id, uid_validity, uid_next, highest_modseq, lowest_uid, last_full_flag_sync_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder_id) DO UPDATE SET
           uid_validity = excluded.uid_validity, uid_next = excluded.uid_next,
           highest_modseq = excluded.highest_modseq, lowest_uid = excluded.lowest_uid,
           last_full_flag_sync_at = excluded.last_full_flag_sync_at`
      ).run(
        folderId,
        merged.uidValidity ?? null,
        merged.uidNext ?? null,
        merged.highestModseq ?? null,
        merged.lowestUid ?? null,
        merged.lastFullFlagSyncAt ?? null
      )
    },

    clearFolder(folderId: string): void {
      conn().transaction(() => {
        const threads = threadIdsForMessages('folder_id = ?', folderId)
        run('DELETE FROM messages WHERE folder_id = ?', folderId)
        run('DELETE FROM folder_sync_state WHERE folder_id = ?', folderId)
        run('UPDATE folders SET unread_count = 0, total_count = 0 WHERE id = ?', folderId)
        recomputeThreads(threads)
      })()
    },

    // Messages --------------------------------------------------------------

    upsertMessage(msg: MessageUpsert) {
      return store.upsertMessages([msg])[0] as { message: MessageSummary; isNew: boolean }
    },

    upsertMessages(msgs: MessageUpsert[]) {
      if (msgs.length === 0) return []
      return conn().transaction(() => {
        const dirty = new Set<string>()
        const out = msgs.map((m) => upsertOne(m, dirty))
        recomputeThreads(dirty)
        // Thread ids may have shifted through merges; re-read the affected summaries.
        return out.map((r) => {
          const row = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(r.message.id)
          return row ? { message: toSummary(row), isNew: r.isNew } : r
        })
      })()
    },

    setMessageBody(messageId: string, body: MessageBody): void {
      const row = q('SELECT thread_id FROM messages WHERE id = ?').get<{ thread_id: string }>(messageId)
      if (!row) return
      conn().transaction(() => {
        storeBody(messageId, body)
        recomputeThread(row.thread_id)
      })()
    },

    updateFlags(folderId: string, uid: number, flags: Partial<MessageFlags>): void {
      store.updateFlagsBulk([{ folderId, uid, flags }])
    },

    updateFlagsBulk(updates): void {
      if (updates.length === 0) return
      conn().transaction(() => {
        const dirty = new Set<string>()
        for (const u of updates) {
          const sets: string[] = []
          const params: SqlParam[] = []
          for (const key of ['seen', 'flagged', 'answered', 'draft', 'forwarded'] as (keyof MessageFlags)[]) {
            const value = u.flags[key]
            if (value === undefined) continue
            sets.push(`${key} = ?`)
            params.push(value ? 1 : 0)
          }
          if (sets.length === 0) continue
          const row = q('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ?').get<{
            id: string
            thread_id: string
          }>(u.folderId, u.uid)
          if (!row) continue
          q(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id)
          dirty.add(row.thread_id)
        }
        recomputeThreads(dirty)
      })()
    },

    deleteByUids(folderId: string, uids: number[]): void {
      if (uids.length === 0) return
      conn().transaction(() => {
        const dirty = new Set<string>()
        for (let i = 0; i < uids.length; i += 400) {
          const chunk = uids.slice(i, i + 400)
          for (const t of threadIdsForMessages(
            `folder_id = ? AND uid IN (${placeholders(chunk.length)})`,
            folderId,
            ...chunk
          )) {
            dirty.add(t)
          }
          removeOrDemote(folderId, `folder_id = ? AND uid IN (${placeholders(chunk.length)})`, folderId, ...chunk)
        }
        recomputeThreads(dirty)
      })()
    },

    reconcileUids(folderId: string, presentUids: number[], minUid: number): { removed: number } {
      return conn().transaction(() => {
        const database = conn()
        database.exec('CREATE TEMP TABLE IF NOT EXISTS present_uids (uid INTEGER PRIMARY KEY)')
        database.exec('DELETE FROM present_uids')
        const insert = database.prepare('INSERT OR IGNORE INTO present_uids (uid) VALUES (?)')
        for (const uid of presentUids) insert.run(uid)
        const dirty = new Set(
          threadIdsForMessages(
            'folder_id = ? AND uid >= ? AND uid NOT IN (SELECT uid FROM present_uids)',
            folderId,
            minUid
          )
        )
        const removed = removeOrDemote(
          folderId,
          'folder_id = ? AND uid >= ? AND uid NOT IN (SELECT uid FROM present_uids)',
          folderId,
          minUid
        )
        database.exec('DELETE FROM present_uids')
        recomputeThreads(dirty)
        return { removed }
      })()
    },

    moveMessage(messageId: string, targetFolderId: string, newUid?: number): void {
      conn().transaction(() => {
        const row = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(messageId)
        if (!row) return
        const target = requireFolder(targetFolderId)
        let uid = newUid
        if (uid === undefined) {
          // No server UID yet: park it on a negative, folder-unique placeholder.
          const min = q('SELECT MIN(uid) AS m FROM messages WHERE folder_id = ?').get<{ m: number | null }>(
            targetFolderId
          )
          uid = Math.min(-1, Number(min?.m ?? 0) - 1)
        } else {
          const clash = q('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ? AND id <> ?').get<{
            id: string
            thread_id: string
          }>(targetFolderId, uid, messageId)
          if (clash) {
            run('DELETE FROM messages WHERE id = ?', clash.id)
            if (clash.thread_id !== row.thread_id) recomputeThread(clash.thread_id)
          }
        }
        run(
          'UPDATE messages SET folder_id = ?, account_id = ?, uid = ? WHERE id = ?',
          targetFolderId,
          target.account_id,
          uid,
          messageId
        )
        recomputeThread(row.thread_id)
      })()
    },

    getMessage(messageId: string): MessageFull | undefined {
      const row = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(messageId)
      return row ? toFull(row) : undefined
    },

    getMessageSummary(messageId: string): MessageSummary | undefined {
      const row = q('SELECT * FROM messages WHERE id = ?').get<MessageRow>(messageId)
      return row ? toSummary(row) : undefined
    },

    getMessageByUid(folderId: string, uid: number): MessageSummary | undefined {
      const row = q('SELECT * FROM messages WHERE folder_id = ? AND uid = ?').get<MessageRow>(folderId, uid)
      return row ? toSummary(row) : undefined
    },

    getMessageByHeaderId(accountId: string, messageIdHeader: string): MessageSummary | undefined {
      const row = q(
        'SELECT * FROM messages WHERE account_id = ? AND message_id_header = ? ORDER BY date DESC LIMIT 1'
      ).get<MessageRow>(accountId, normaliseMessageId(messageIdHeader))
      return row ? toSummary(row) : undefined
    },

    listUids(folderId: string): number[] {
      return q('SELECT uid FROM messages WHERE folder_id = ? AND uid > 0 ORDER BY uid ASC')
        .all<{ uid: number }>(folderId)
        .map((r) => r.uid)
    },

    listMessagesWithoutBody(folderId: string, limit: number): MessageSummary[] {
      return q(
        'SELECT * FROM messages WHERE folder_id = ? AND body_fetched = 0 ORDER BY date DESC LIMIT ?'
      )
        .all<MessageRow>(folderId, Math.max(1, limit))
        .map(toSummary)
    },

    listUidsWithoutSnippet(folderId: string, limit: number): number[] {
      return q(
        "SELECT uid FROM messages WHERE folder_id = ? AND uid > 0 AND snippet = '' AND body_fetched = 0 ORDER BY uid DESC LIMIT ?"
      )
        .all<{ uid: number }>(folderId, Math.max(1, limit))
        .map((r) => Number(r.uid))
    },

    setSnippets(updates): void {
      if (!updates.length) return
      conn().transaction(() => {
        const dirty = new Set<string>()
        for (const u of updates) {
          const row = q('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ?').get<{ id: string; thread_id: string }>(
            u.folderId,
            u.uid
          )
          if (!row) continue
          run('UPDATE messages SET snippet = ? WHERE id = ?', u.snippet, row.id)
          reindexMessage(row.id)
          dirty.add(row.thread_id)
        }
        recomputeThreads(dirty)
      })()
    },

    listMessages(query: MessageListQuery): MessageListResult {
      const { sql, params } = threadFilters(query ?? {})
      return pageThreads(sql, params, '', [], query?.limit, query?.cursor, true)
    },

    getThread(threadId: string): MessageFull[] {
      return q('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC, seq ASC')
        .all<MessageRow>(threadId)
        .map(toFull)
    },

    getThreadSummary(threadId: string): ThreadSummary | undefined {
      const row = q('SELECT * FROM threads WHERE id = ?').get<ThreadRow>(threadId)
      if (!row) return undefined
      return toThreadSummaries([row])[0]
    },

    search(query: SearchQuery): MessageListResult {
      const parsed = parseSearchQuery(query?.q ?? '')
      const conds: string[] = []
      const joinParams: SqlParam[] = []
      const needFolders = parsed.needsFolders || !!query?.folderKind

      let from: string
      if (parsed.fts && ftsEnabled) {
        // No alias on messages_fts: the hidden MATCH column always carries the real table name.
        from = `FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid${
          needFolders ? ' JOIN folders fo ON fo.id = m.folder_id' : ''
        } WHERE messages_fts MATCH ?`
        joinParams.push(parsed.fts)
      } else {
        from = `FROM messages m${
          needFolders ? ' JOIN folders fo ON fo.id = m.folder_id' : ''
        } WHERE 1 = 1`
        if (parsed.fts && !ftsEnabled) {
          // No FTS5 in this build: degrade to a LIKE scan over subject/snippet.
          const needle = `%${escapeLike([...parsed.terms.text, ...parsed.terms.phrases].join(' '))}%`
          conds.push("(m.subject LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\')")
          joinParams.push(needle, needle)
        }
      }

      conds.push(...parsed.where)
      const subParams: SqlParam[] = [...parsed.params]
      if (query?.accountId) {
        conds.push('m.account_id = ?')
        subParams.push(query.accountId)
      }
      if (query?.folderKind) {
        conds.push('fo.kind = ?')
        subParams.push(query.folderKind)
      }

      const subquery = `SELECT DISTINCT m.thread_id AS tid ${from}${
        conds.length > 0 ? ` AND ${conds.join(' AND ')}` : ''
      }`
      const join = `JOIN (${subquery}) hits ON hits.tid = t.id`
      return pageThreads([], [], join, [...joinParams, ...subParams], query?.limit, query?.cursor, true)
    },

    unreadCounts(): UnreadCounts {
      const inbox = q(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE f.kind = 'inbox' AND m.seen = 0 AND a.enabled = 1`
      ).get<{ n: number }>()
      const byAccount: Record<string, number> = {}
      for (const row of q(
        `SELECT m.account_id AS id, COUNT(*) AS n FROM messages m
         JOIN folders f ON f.id = m.folder_id
         WHERE f.kind = 'inbox' AND m.seen = 0 GROUP BY m.account_id`
      ).all<{ id: string; n: number }>()) {
        byAccount[row.id] = Number(row.n)
      }
      const byFolder: Record<string, number> = {}
      for (const row of q(
        'SELECT folder_id AS id, COUNT(*) AS n FROM messages WHERE seen = 0 GROUP BY folder_id'
      ).all<{ id: string; n: number }>()) {
        byFolder[row.id] = Number(row.n)
      }
      return { inbox: Number(inbox?.n ?? 0), byAccount, byFolder }
    },

    suggestContacts(qStr: string, limit: number) {
      const max = Math.min(Math.max(Number(limit) || 10, 1), 50)
      const needle = (qStr ?? '').trim()
      if (!needle) {
        return q('SELECT address, name, count FROM contacts ORDER BY count DESC, last_seen DESC LIMIT ?')
          .all<{ address: string; name: string | null; count: number }>(max)
          .map((r) => ({ name: r.name ?? undefined, address: r.address, count: r.count }))
      }
      const prefix = `${escapeLike(needle.toLowerCase())}%`
      return q(
        `SELECT address, name, count FROM contacts
         WHERE address LIKE ? ESCAPE '\\' OR LOWER(COALESCE(name, '')) LIKE ? ESCAPE '\\'
         ORDER BY count DESC, last_seen DESC LIMIT ?`
      )
        .all<{ address: string; name: string | null; count: number }>(prefix, prefix, max)
        .map((r) => ({ name: r.name ?? undefined, address: r.address, count: r.count }))
    },

    // Attachments -----------------------------------------------------------

    getAttachment(attachmentId: string): AttachmentMeta | undefined {
      const row = q('SELECT * FROM attachments WHERE id = ?').get<AttachmentRow>(attachmentId)
      return row ? toAttachment(row) : undefined
    },

    setAttachmentLocalPath(attachmentId: string, localPath: string): void {
      run('UPDATE attachments SET local_path = ? WHERE id = ?', localPath, attachmentId)
    },

    // Drafts / outbox / pending actions --------------------------------------

    saveDraft(payload: ComposePayload, remoteUid?: number): Draft {
      const id = payload.draftId ?? randomUUID()
      const stored: ComposePayload = { ...payload, draftId: id }
      const updatedAt = Date.now()
      q(
        `INSERT INTO drafts (id, account_id, payload_json, updated_at, remote_uid)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id, payload_json = excluded.payload_json,
           updated_at = excluded.updated_at,
           remote_uid = COALESCE(excluded.remote_uid, drafts.remote_uid)`
      ).run(id, payload.accountId, JSON.stringify(stored), updatedAt, remoteUid ?? null)
      return store.getDraft(id) as Draft
    },

    getDraft(draftId: string): Draft | undefined {
      const row = q('SELECT * FROM drafts WHERE id = ?').get<{
        id: string
        account_id: string
        payload_json: string
        updated_at: number
        remote_uid: number | null
      }>(draftId)
      if (!row) return undefined
      return {
        id: row.id,
        accountId: row.account_id,
        payload: jsonOr<ComposePayload>(row.payload_json, {
          accountId: row.account_id,
          to: [],
          cc: [],
          bcc: [],
          subject: '',
          html: '',
          attachments: []
        }),
        updatedAt: row.updated_at,
        remoteUid: row.remote_uid ?? undefined
      }
    },

    listDrafts(accountId?: string): Draft[] {
      const rows = accountId
        ? q('SELECT id FROM drafts WHERE account_id = ? ORDER BY updated_at DESC').all<{ id: string }>(accountId)
        : q('SELECT id FROM drafts ORDER BY updated_at DESC').all<{ id: string }>()
      return rows.map((r) => store.getDraft(r.id)).filter((d): d is Draft => !!d)
    },

    deleteDraft(draftId: string): void {
      run('DELETE FROM drafts WHERE id = ?', draftId)
    },

    enqueueAction(action): PendingAction {
      const id = randomUUID()
      const createdAt = Date.now()
      q(
        `INSERT INTO pending_actions (id, account_id, request_json, targets_json, created_at, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).run(
        id,
        action.accountId,
        JSON.stringify(action.request),
        JSON.stringify(action.targets ?? []),
        createdAt,
        action.lastError ?? null
      )
      return {
        id,
        accountId: action.accountId,
        request: action.request,
        targets: action.targets ?? [],
        createdAt,
        attempts: 0,
        lastError: action.lastError
      }
    },

    listPendingActions(accountId: string): PendingAction[] {
      return q('SELECT * FROM pending_actions WHERE account_id = ? ORDER BY created_at ASC')
        .all<{
          id: string
          account_id: string
          request_json: string
          targets_json: string
          created_at: number
          attempts: number
          last_error: string | null
        }>(accountId)
        .map((r) => ({
          id: r.id,
          accountId: r.account_id,
          request: jsonOr<MessageActionRequest>(r.request_json, { action: 'markRead', messageIds: [] }),
          targets: jsonOr<PendingAction['targets']>(r.targets_json, []),
          createdAt: r.created_at,
          attempts: r.attempts,
          lastError: r.last_error ?? undefined
        }))
    },

    completeAction(id: string): void {
      run('DELETE FROM pending_actions WHERE id = ?', id)
    },

    failAction(id: string, error: string): void {
      run('UPDATE pending_actions SET attempts = attempts + 1, last_error = ? WHERE id = ?', error, id)
    },

    enqueueOutbox(payload: ComposePayload): OutboxItem {
      const id = randomUUID()
      const createdAt = Date.now()
      q(
        `INSERT INTO outbox (id, account_id, payload_json, created_at, attempts, status)
         VALUES (?, ?, ?, ?, 0, 'queued')`
      ).run(id, payload.accountId, JSON.stringify(payload), createdAt)
      return { id, accountId: payload.accountId, payload, createdAt, attempts: 0, status: 'queued' }
    },

    listOutbox(accountId?: string): OutboxItem[] {
      const rows = accountId
        ? q('SELECT * FROM outbox WHERE account_id = ? ORDER BY created_at ASC').all<{
            id: string
            account_id: string
            payload_json: string
            created_at: number
            attempts: number
            last_error: string | null
            status: string
          }>(accountId)
        : q('SELECT * FROM outbox ORDER BY created_at ASC').all<{
            id: string
            account_id: string
            payload_json: string
            created_at: number
            attempts: number
            last_error: string | null
            status: string
          }>()
      return rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        payload: jsonOr<ComposePayload>(r.payload_json, {
          accountId: r.account_id,
          to: [],
          cc: [],
          bcc: [],
          subject: '',
          html: '',
          attachments: []
        }),
        createdAt: r.created_at,
        attempts: r.attempts,
        lastError: r.last_error ?? undefined,
        status: (r.status as OutboxItem['status']) ?? 'queued'
      }))
    },

    updateOutbox(id, patch): void {
      const sets: string[] = []
      const params: SqlParam[] = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.attempts !== undefined) {
        sets.push('attempts = ?')
        params.push(patch.attempts)
      }
      if (patch.lastError !== undefined) {
        sets.push('last_error = ?')
        params.push(patch.lastError ?? null)
      }
      if (sets.length === 0) return
      q(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    },

    deleteOutbox(id: string): void {
      run('DELETE FROM outbox WHERE id = ?', id)
    },

    // Settings --------------------------------------------------------------

    getSettings(): AppSettings {
      return readSettings()
    },

    setSettings(patch: Partial<AppSettings>): AppSettings {
      const current = readSettings()
      const next: AppSettings = {
        ...current,
        ...patch,
        oauthClients: { ...current.oauthClients, ...(patch.oauthClients ?? {}) }
      }
      q(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      ).run(SETTINGS_KEY, JSON.stringify(next))
      return next
    }
  }

  return store
}

export default createMailStore
