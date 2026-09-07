/**
 * Per account sync loop: folder list, newest-first envelope sync, background
 * backfill, body prefetch, flag reconciliation and IDLE on INBOX.
 */
import type { ImapFlow } from 'imapflow'
import log from 'electron-log/main'
import type { Account, Folder, FolderKind, MessageSummary, SyncState, SyncStatus } from '@shared/types'
import type { AuthService, FolderUpsert, MailEngineEvents, MailStore, MessageUpsert } from '../contracts'
import { AccountConnection, classifyError, errorMessage } from './connection'
import { mapFolders, providerQuirks, type MailboxInfo, type ProviderQuirks } from './providers'
import { parseFlags, parseMessageSource, toMessageUpsert, type ImapMessageLike } from './parse'

const syncLog = log.scope('imap')

export const HEAD_FETCH_COUNT = 200
export const BACKFILL_CHUNK = 200
export const BODY_PREFETCH_COUNT = 50
export const BODY_PREFETCH_BATCH = 5
const FLAG_SYNC_INTERVAL_MS = 15 * 60_000

type FetchQuery = Parameters<ImapFlow['fetch']>[1]
type FetchOptions = Parameters<ImapFlow['fetch']>[2]

export interface SyncDeps {
  store: MailStore
  auth: AuthService
  emit: MailEngineEvents
  /** Called once a connection is live so pending actions / the outbox can be replayed. */
  onConnected?: (accountId: string) => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.length) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

interface MailboxLike {
  path: string
  exists?: number
  uidNext?: number
  uidValidity?: number | bigint
  highestModseq?: number | bigint
  noModseq?: boolean
}

/** Keeps one account in sync. Owns two IMAP connections: idle (INBOX) + worker. */
export class AccountSyncer {
  readonly accountId: string
  readonly worker: AccountConnection
  readonly idle: AccountConnection
  quirks: ProviderQuirks

  private account: Account
  private readonly deps: SyncDeps
  private state: SyncState = 'idle'
  private detail: string | undefined
  private lastError: string | undefined
  private progress: number | undefined
  private running = false
  private rerun = false
  private stopped = true
  private backfilling = false
  private pollTimer: NodeJS.Timeout | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private inboxFolderId: string | undefined
  private lastInboxUid = 0

  constructor(account: Account, deps: SyncDeps) {
    this.account = account
    this.accountId = account.id
    this.deps = deps
    this.quirks = providerQuirks(account.provider)
    this.worker = new AccountConnection(account.id, 'worker', {
      store: deps.store,
      auth: deps.auth,
      hooks: {
        onAuthError: (message, needsReauth) => this.handleAuthError(message, needsReauth),
        onNetworkError: (message) => this.handleNetworkError(message)
      }
    })
    this.idle = new AccountConnection(account.id, 'idle', {
      store: deps.store,
      auth: deps.auth,
      hooks: {
        onConnected: (client) => this.onIdleConnected(client),
        onAuthError: (message, needsReauth) => this.handleAuthError(message, needsReauth),
        onNetworkError: (message) => this.handleNetworkError(message)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const account = this.deps.store.getAccount(this.accountId)
    if (account) this.account = account
    this.quirks = providerQuirks(this.account.provider)
    if (!this.account.enabled) {
      this.setStatus('disabled')
      return
    }
    this.stopped = false
    this.setStatus('connecting')
    // The first pass runs detached so app startup is not blocked by a slow server.
    void this.syncNow().catch((err) => syncLog.warn(`[${this.account.email}] initial sync failed: ${errorMessage(err)}`))
    this.startPolling()
    void this.startIdle()
    await Promise.resolve()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer)
      this.reconcileTimer = null
    }
    await Promise.allSettled([this.worker.close(), this.idle.close()])
    this.setStatus('idle')
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    const seconds = Math.max(60, this.deps.store.getSettings().pollIntervalSec || 300)
    this.pollTimer = setInterval(() => {
      void this.syncNow().catch((err) => syncLog.warn(`[${this.account.email}] poll failed: ${errorMessage(err)}`))
    }, seconds * 1000)
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref()
  }

  private async startIdle(): Promise<void> {
    try {
      await this.idle.ensure()
    } catch (err) {
      syncLog.warn(`[${this.account.email}] IDLE connection failed: ${errorMessage(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  getStatus(): SyncStatus {
    return {
      accountId: this.accountId,
      state: this.state,
      detail: this.detail,
      lastSyncAt: this.account.lastSyncAt,
      error: this.lastError,
      progress: this.progress
    }
  }

  private setStatus(state: SyncState, detail?: string, progress?: number): void {
    this.state = state
    this.detail = detail
    this.progress = progress
    if (state !== 'error') this.lastError = undefined
    try {
      this.deps.emit.status(this.getStatus())
    } catch (err) {
      syncLog.warn('status emit failed', errorMessage(err))
    }
  }

  private setError(message: string): void {
    this.lastError = message
    this.state = 'error'
    this.detail = undefined
    try {
      this.deps.store.updateAccount(this.accountId, { lastError: message })
    } catch {
      /* store may be closing */
    }
    try {
      this.deps.emit.status(this.getStatus())
    } catch {
      /* ignore */
    }
  }

  private handleAuthError(message: string, needsReauth: boolean): void {
    this.setError(message)
    try {
      this.deps.emit.authError({ accountId: this.accountId, message, needsReauth })
    } catch (err) {
      syncLog.warn('authError emit failed', errorMessage(err))
    }
  }

  private handleNetworkError(message: string): void {
    this.lastError = message
    this.state = 'offline'
    this.detail = message
    try {
      this.deps.emit.status(this.getStatus())
    } catch {
      /* ignore */
    }
  }

  /** The user re-authorised: drop the latch and reconnect. */
  reauthorised(): void {
    this.worker.resetAuth()
    this.idle.resetAuth()
    void this.syncNow().catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  async refreshFolders(): Promise<Folder[]> {
    const boxes = await this.worker.withClient(async (client) => {
      const listed = (await client.list({ statusQuery: { messages: true, unseen: true } })) as unknown as (MailboxInfo & {
        status?: { messages?: number; unseen?: number }
      })[]
      return listed
    })
    const mapped = mapFolders(this.account.provider, boxes)
    const upserts: FolderUpsert[] = mapped.map((entry) => ({
      accountId: this.accountId,
      path: entry.path,
      name: entry.name,
      delimiter: entry.delimiter,
      kind: entry.kind,
      synced: entry.synced
    }))
    const folders = this.deps.store.replaceFolders(this.accountId, upserts)
    for (const folder of folders) {
      const box = boxes.find((b) => b.path === folder.path)
      const status = box?.status
      if (status) {
        this.deps.store.updateFolderCounts(folder.id, {
          totalCount: typeof status.messages === 'number' ? status.messages : undefined,
          unreadCount: typeof status.unseen === 'number' ? status.unseen : undefined
        })
      }
    }
    const inbox = folders.find((f) => f.kind === 'inbox')
    this.inboxFolderId = inbox?.id
    if (inbox && !this.lastInboxUid) {
      const uids = this.deps.store.listUids(inbox.id)
      this.lastInboxUid = uids.length ? Math.max(...uids) : 0
    }
    try {
      this.deps.emit.foldersChanged(this.accountId)
    } catch {
      /* ignore */
    }
    return folders
  }

  /** Folder of the given kind, creating a remote mailbox when the provider allows it. */
  async ensureFolderKind(kind: FolderKind): Promise<Folder | undefined> {
    const existing = this.deps.store.getFolderByKind(this.accountId, kind)
    if (existing) return existing
    if (kind !== 'archive' || !this.quirks.createArchiveIfMissing) return undefined
    const folders = this.deps.store.listFolders(this.accountId)
    const delimiter = folders[0]?.delimiter || '/'
    const inboxPrefixed = folders.filter((f) => f.kind !== 'inbox').every((f) => f.path.toUpperCase().startsWith(`INBOX${delimiter}`.toUpperCase()))
    const path = inboxPrefixed && folders.length > 1 ? `INBOX${delimiter}Archive` : 'Archive'
    try {
      await this.worker.withClient((client) => client.mailboxCreate(path))
    } catch (err) {
      syncLog.warn(`[${this.account.email}] could not create ${path}: ${errorMessage(err)}`)
    }
    await this.refreshFolders().catch(() => undefined)
    return this.deps.store.getFolderByKind(this.accountId, kind)
  }

  // -------------------------------------------------------------------------
  // Sync passes
  // -------------------------------------------------------------------------

  async syncNow(): Promise<void> {
    if (this.stopped) return
    const account = this.deps.store.getAccount(this.accountId)
    if (!account) return
    this.account = account
    if (!account.enabled) {
      this.setStatus('disabled')
      return
    }
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      do {
        this.rerun = false
        await this.runPass()
      } while (this.rerun && !this.stopped)
    } finally {
      this.running = false
    }
  }

  private async runPass(): Promise<void> {
    this.setStatus('connecting')
    let folders: Folder[]
    try {
      folders = await this.refreshFolders()
    } catch (err) {
      const info = classifyError(err)
      if (info.kind === 'auth') this.handleAuthError(info.message, info.needsReauth)
      else if (info.kind === 'network') this.handleNetworkError(info.message)
      else this.setError(info.message)
      return
    }

    let failures = 0
    const synced = folders.filter((f) => f.synced)
    // INBOX first so the user sees new mail quickly.
    synced.sort((a, b) => (a.kind === 'inbox' ? -1 : 0) - (b.kind === 'inbox' ? -1 : 0))
    for (const folder of synced) {
      if (this.stopped) return
      try {
        await this.syncFolderHead(folder)
      } catch (err) {
        failures += 1
        syncLog.warn(`[${this.account.email}] ${folder.path} sync failed: ${errorMessage(err)}`)
      }
    }

    try {
      this.deps.store.updateAccount(this.accountId, { lastSyncAt: Date.now(), lastError: failures ? this.lastError : undefined })
      const refreshed = this.deps.store.getAccount(this.accountId)
      if (refreshed) this.account = refreshed
    } catch {
      /* ignore */
    }

    try {
      this.deps.emit.changed({ accountId: this.accountId, reason: 'sync' })
    } catch {
      /* ignore */
    }

    this.setStatus(this.idle.connected ? 'listening' : 'syncing', undefined, undefined)
    void this.runBackground(synced)

    if (this.deps.onConnected) {
      try {
        await this.deps.onConnected(this.accountId)
      } catch (err) {
        syncLog.warn(`[${this.account.email}] replay failed: ${errorMessage(err)}`)
      }
    }
  }

  /** Backfill + body prefetch, detached so a pass returns as soon as heads are in. */
  private async runBackground(folders: Folder[]): Promise<void> {
    if (this.backfilling || this.stopped) return
    this.backfilling = true
    try {
      for (const folder of folders) {
        if (this.stopped) break
        // Gmail's All Mail mirrors every other folder - backfill it, never prefetch bodies there.
        try {
          await this.backfillFolder(folder)
        } catch (err) {
          syncLog.warn(`[${this.account.email}] backfill ${folder.path} failed: ${errorMessage(err)}`)
        }
      }
      for (const folder of folders) {
        if (this.stopped) break
        if (!this.quirks.bodyPrefetchKinds.includes(folder.kind)) continue
        try {
          await this.prefetchBodies(folder)
        } catch (err) {
          syncLog.warn(`[${this.account.email}] body prefetch ${folder.path} failed: ${errorMessage(err)}`)
        }
      }
      if (!this.stopped) this.setStatus(this.idle.connected ? 'listening' : 'idle')
    } finally {
      this.backfilling = false
    }
  }

  private fetchQuery(client: ImapFlow, extra?: { source?: boolean }): FetchQuery {
    const gmail = this.quirks.gmailExtensions && hasCapability(client, 'X-GM-EXT-1')
    const query: Record<string, unknown> = {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      headers: ['references', 'in-reply-to']
    }
    if (gmail) {
      query.labels = true
      query.threadId = true
      query.emailId = true
    }
    if (extra?.source) query.source = true
    return query as unknown as FetchQuery
  }

  private async fetchRange(client: ImapFlow, range: string, query: FetchQuery, folderId: string): Promise<MessageUpsert[]> {
    const rows: MessageUpsert[] = []
    const options = { uid: true } as unknown as FetchOptions
    for await (const message of client.fetch(range, query, options)) {
      const like = message as unknown as ImapMessageLike
      if (typeof like.uid !== 'number') continue
      rows.push(toMessageUpsert({ accountId: this.accountId, folderId }, like))
    }
    return rows
  }

  /** Newest HEAD_FETCH_COUNT envelopes plus UIDVALIDITY / flag reconciliation. */
  private async syncFolderHead(folder: Folder): Promise<void> {
    await this.worker.withMailbox(folder.path, async (client) => {
      const mailbox = client.mailbox as unknown as MailboxLike | false
      if (!mailbox) throw new Error(`Could not open ${folder.path}`)
      const uidValidity = toNumber(mailbox.uidValidity)
      const uidNext = toNumber(mailbox.uidNext) ?? 1
      const exists = toNumber(mailbox.exists) ?? 0
      const highestModseq = mailbox.highestModseq !== undefined ? String(mailbox.highestModseq) : undefined

      let state = this.deps.store.getFolderSyncState(folder.id)
      if (state.uidValidity && uidValidity && state.uidValidity !== uidValidity) {
        syncLog.info(`[${this.account.email}] ${folder.path} UIDVALIDITY changed, clearing cache`)
        this.deps.store.clearFolder(folder.id)
        state = {}
        if (folder.kind === 'inbox') this.lastInboxUid = 0
      }

      this.deps.store.updateFolderCounts(folder.id, { totalCount: exists })
      if (exists === 0) {
        this.deps.store.setFolderSyncState(folder.id, { uidValidity, uidNext, highestModseq, lowestUid: state.lowestUid })
        return
      }

      this.setStatus('syncing', `${folder.name} ${Math.min(exists, HEAD_FETCH_COUNT)}/${exists}`)
      const start = Math.max(1, uidNext - HEAD_FETCH_COUNT)
      const rows = await this.fetchRange(client, `${start}:*`, this.fetchQuery(client), folder.id)
      if (rows.length) this.deps.store.upsertMessages(rows)

      const uids = rows.map((r) => r.uid)
      const lowestSeen = uids.length ? Math.min(...uids) : state.lowestUid
      const lowestUid = state.lowestUid ? Math.min(state.lowestUid, lowestSeen ?? state.lowestUid) : lowestSeen
      this.deps.store.setFolderSyncState(folder.id, { uidValidity, uidNext, highestModseq, lowestUid })

      if (folder.kind === 'inbox' && uids.length) this.lastInboxUid = Math.max(this.lastInboxUid, ...uids)

      await this.reconcileFlags(client, folder, state, highestModseq)
    })
  }

  /** CONDSTORE delta when available, otherwise a periodic full flag listing. */
  private async reconcileFlags(
    client: ImapFlow,
    folder: Folder,
    previous: { highestModseq?: string; lowestUid?: number; lastFullFlagSyncAt?: number },
    highestModseq: string | undefined
  ): Promise<void> {
    const condstore = hasCapability(client, 'CONDSTORE')
    const cachedUids = this.deps.store.listUids(folder.id)
    if (!cachedUids.length) return
    const minUid = Math.min(...cachedUids)

    if (condstore && previous.highestModseq && previous.highestModseq !== highestModseq) {
      try {
        const updates: { folderId: string; uid: number; flags: ReturnType<typeof parseFlags> }[] = []
        const options = { uid: true, changedSince: BigInt(previous.highestModseq) } as unknown as FetchOptions
        const query = { uid: true, flags: true } as unknown as FetchQuery
        for await (const message of client.fetch(`${minUid}:*`, query, options)) {
          const like = message as unknown as ImapMessageLike
          if (typeof like.uid !== 'number') continue
          updates.push({ folderId: folder.id, uid: like.uid, flags: parseFlags(like.flags) })
        }
        if (updates.length) this.deps.store.updateFlagsBulk(updates)
        return
      } catch (err) {
        syncLog.warn(`[${this.account.email}] CONDSTORE flag sync failed, falling back: ${errorMessage(err)}`)
      }
    }

    const last = previous.lastFullFlagSyncAt ?? 0
    if (Date.now() - last < FLAG_SYNC_INTERVAL_MS) return
    const present: number[] = []
    const updates: { folderId: string; uid: number; flags: ReturnType<typeof parseFlags> }[] = []
    const query = { uid: true, flags: true } as unknown as FetchQuery
    const options = { uid: true } as unknown as FetchOptions
    for await (const message of client.fetch(`${minUid}:*`, query, options)) {
      const like = message as unknown as ImapMessageLike
      if (typeof like.uid !== 'number') continue
      present.push(like.uid)
      updates.push({ folderId: folder.id, uid: like.uid, flags: parseFlags(like.flags) })
    }
    if (updates.length) this.deps.store.updateFlagsBulk(updates)
    if (present.length) this.deps.store.reconcileUids(folder.id, present, minUid)
    const current = this.deps.store.getFolderSyncState(folder.id)
    this.deps.store.setFolderSyncState(folder.id, { ...current, lastFullFlagSyncAt: Date.now() })
  }

  /** Walk backwards in BACKFILL_CHUNK sized UID ranges until cacheLimit is reached. */
  private async backfillFolder(folder: Folder): Promise<void> {
    const limit = this.account.cacheLimit && this.account.cacheLimit > 0 ? this.account.cacheLimit : Number.POSITIVE_INFINITY
    let guard = 0
    for (;;) {
      if (this.stopped || guard++ > 500) return
      const state = this.deps.store.getFolderSyncState(folder.id)
      const cached = this.deps.store.listUids(folder.id)
      const lowest = state.lowestUid ?? (cached.length ? Math.min(...cached) : undefined)
      // All Mail mirrors other folders and the store keeps only one row per Gmail message, so its
      // cached row count barely grows; measure its progress by the UID range walked instead.
      const walked = folder.kind === 'all' && state.uidNext && lowest ? state.uidNext - lowest : cached.length
      if (walked >= limit) return
      if (!lowest || lowest <= 1) return
      const end = lowest - 1
      const start = Math.max(1, end - BACKFILL_CHUNK + 1)
      const total = this.deps.store.getFolder(folder.id)?.totalCount ?? cached.length
      this.setStatus('syncing', `${folder.name} ${cached.length}/${Math.min(total, limit === Number.POSITIVE_INFINITY ? total : limit)}`,
        total ? Math.min(1, cached.length / Math.max(1, Math.min(total, limit))) : undefined)
      try {
        await this.worker.withMailbox(folder.path, async (client) => {
          const rows = await this.fetchRange(client, `${start}:${end}`, this.fetchQuery(client), folder.id)
          if (rows.length) this.deps.store.upsertMessages(rows)
        })
      } catch (err) {
        syncLog.warn(`[${this.account.email}] backfill chunk ${start}:${end} failed: ${errorMessage(err)}`)
        return
      }
      const current = this.deps.store.getFolderSyncState(folder.id)
      this.deps.store.setFolderSyncState(folder.id, { ...current, lowestUid: start })
      if (start <= 1) return
      await sleep(120) // yield: keep the UI and other folders responsive
    }
  }

  /** Fetch bodies for the newest messages that have none yet. */
  private async prefetchBodies(folder: Folder): Promise<void> {
    const pending = this.deps.store.listMessagesWithoutBody(folder.id, BODY_PREFETCH_COUNT)
    if (!pending.length) return
    for (let i = 0; i < pending.length; i += BODY_PREFETCH_BATCH) {
      if (this.stopped) return
      const batch = pending.slice(i, i + BODY_PREFETCH_BATCH)
      const byUid = new Map(batch.map((m) => [m.uid, m]))
      try {
        await this.worker.withMailbox(folder.path, async (client) => {
          const query = { uid: true, source: true, bodyStructure: true } as unknown as FetchQuery
          const options = { uid: true } as unknown as FetchOptions
          for await (const message of client.fetch(batch.map((m) => m.uid).join(','), query, options)) {
            const like = message as unknown as ImapMessageLike
            const summary = byUid.get(like.uid)
            if (!summary || !like.source) continue
            const body = await parseMessageSource(like.source, like.bodyStructure)
            this.deps.store.setMessageBody(summary.id, {
              html: body.html,
              text: body.text,
              headers: body.headers,
              attachments: body.attachments
            })
          }
        })
      } catch (err) {
        syncLog.warn(`[${this.account.email}] body prefetch failed: ${errorMessage(err)}`)
        return
      }
      await sleep(80)
    }
    try {
      this.deps.emit.changed({ accountId: this.accountId, folderId: folder.id, reason: 'sync' })
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // IDLE
  // -------------------------------------------------------------------------

  private async onIdleConnected(client: ImapFlow): Promise<void> {
    client.on('exists', () => {
      void this.onExists().catch((err) => syncLog.warn(`exists handler failed: ${errorMessage(err)}`))
    })
    client.on('expunge', () => this.scheduleReconcile())
    client.on('flags', (data) => {
      try {
        this.onFlags(data.uid, data.flags)
      } catch (err) {
        syncLog.warn(`flags handler failed: ${errorMessage(err)}`)
      }
    })
    try {
      await client.mailboxOpen('INBOX')
      this.setStatus('listening')
    } catch (err) {
      syncLog.warn(`[${this.account.email}] could not open INBOX for IDLE: ${errorMessage(err)}`)
    }
    if (this.deps.onConnected) {
      try {
        await this.deps.onConnected(this.accountId)
      } catch (err) {
        syncLog.warn(`[${this.account.email}] replay on connect failed: ${errorMessage(err)}`)
      }
    }
  }

  /** New messages arrived in INBOX: fetch everything above the highest known UID. */
  private async onExists(): Promise<void> {
    if (this.stopped) return
    const inbox = this.inboxFolderId ? this.deps.store.getFolder(this.inboxFolderId) : this.deps.store.getFolderByKind(this.accountId, 'inbox')
    if (!inbox) return
    const since = this.lastInboxUid
    const range = since > 0 ? `${since + 1}:*` : '1:*'
    const fresh: MessageSummary[] = []
    try {
      await this.worker.withMailbox(inbox.path, async (client) => {
        const rows = await this.fetchRange(client, range, this.fetchQuery(client), inbox.id)
        if (!rows.length) return
        const results = this.deps.store.upsertMessages(rows)
        for (const result of results) {
          if (result.message.uid > this.lastInboxUid) this.lastInboxUid = result.message.uid
          if (!result.isNew) continue
          if (result.message.flags.seen) continue
          if (this.isOwnAddress(result.message)) continue
          fresh.push(result.message)
        }
      })
    } catch (err) {
      syncLog.warn(`[${this.account.email}] incremental fetch failed: ${errorMessage(err)}`)
      return
    }
    try {
      this.deps.emit.changed({ accountId: this.accountId, folderId: inbox.id, reason: 'sync' })
      if (fresh.length) this.deps.emit.newMail(this.accountId, fresh)
    } catch (err) {
      syncLog.warn('newMail emit failed', errorMessage(err))
    }
    void this.prefetchBodies(inbox).catch(() => undefined)
  }

  private isOwnAddress(message: MessageSummary): boolean {
    const own = (this.account.email || '').toLowerCase()
    if (!own) return false
    return message.from.some((address) => (address.address || '').toLowerCase() === own)
  }

  private onFlags(rawUid: number | undefined, flags: Set<string> | undefined): void {
    const inboxId = this.inboxFolderId ?? this.deps.store.getFolderByKind(this.accountId, 'inbox')?.id
    if (!inboxId) return
    const uid = toNumber(rawUid)
    if (uid && flags) {
      this.deps.store.updateFlags(inboxId, uid, parseFlags(flags))
      this.deps.emit.changed({ accountId: this.accountId, folderId: inboxId, reason: 'sync' })
      return
    }
    this.scheduleReconcile()
  }

  /** Debounced: something changed in a way we cannot map to a UID, re-list the folder. */
  private scheduleReconcile(): void {
    if (this.reconcileTimer || this.stopped) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      void this.reconcileInbox().catch((err) => syncLog.warn(`reconcile failed: ${errorMessage(err)}`))
    }, 3_000)
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref()
  }

  private async reconcileInbox(): Promise<void> {
    if (this.stopped) return
    const inbox = this.inboxFolderId ? this.deps.store.getFolder(this.inboxFolderId) : this.deps.store.getFolderByKind(this.accountId, 'inbox')
    if (!inbox) return
    const cached = this.deps.store.listUids(inbox.id)
    if (!cached.length) return
    const minUid = Math.min(...cached)
    const present: number[] = []
    const updates: { folderId: string; uid: number; flags: ReturnType<typeof parseFlags> }[] = []
    await this.worker.withMailbox(inbox.path, async (client) => {
      const query = { uid: true, flags: true } as unknown as FetchQuery
      const options = { uid: true } as unknown as FetchOptions
      for await (const message of client.fetch(`${minUid}:*`, query, options)) {
        const like = message as unknown as ImapMessageLike
        if (typeof like.uid !== 'number') continue
        present.push(like.uid)
        updates.push({ folderId: inbox.id, uid: like.uid, flags: parseFlags(like.flags) })
      }
    })
    if (updates.length) this.deps.store.updateFlagsBulk(updates)
    const removed = present.length ? this.deps.store.reconcileUids(inbox.id, present, minUid) : { removed: 0 }
    if (removed.removed || updates.length) {
      this.deps.emit.changed({ accountId: this.accountId, folderId: inbox.id, reason: 'sync' })
    }
  }
}

export function hasCapability(client: ImapFlow, capability: string): boolean {
  const caps = (client as unknown as { capabilities?: Map<string, unknown> }).capabilities
  if (!caps) return false
  const wanted = capability.toUpperCase()
  for (const key of caps.keys()) {
    if (String(key).toUpperCase() === wanted) return true
  }
  return false
}
