/**
 * Main-process service contracts. Each module implements one of these interfaces;
 * the shell (src/main/index.ts + ipc.ts) wires them together.
 *
 * Ownership:
 *   MailStore      -> src/main/db/        (SQLite, FTS, threading, secrets)
 *   MailEngine     -> src/main/mail/      (IMAP/SMTP, sync, actions, sending)
 *   AuthService    -> src/main/auth/      (OAuth flows, presets, autodetect, XOAUTH2)
 *   Shell          -> src/main/index.ts, ipc.ts, windows.ts, tray.ts, notifications.ts
 *
 * Never import a concrete implementation across module boundaries; import the interface
 * from here and receive the instance via constructor/factory argument.
 */
import type {
  Account,
  AccountInput,
  AppSettings,
  AttachmentMeta,
  ComposePayload,
  ConnectionTestResult,
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
  OAuthResult,
  OAuthStartRequest,
  OAuthTokens,
  ProviderPreset,
  SearchQuery,
  ServerSettings,
  SyncStatus,
  ThreadSummary
} from '@shared/types'

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Row the sync engine hands to the store for a newly seen or updated message. */
export interface MessageUpsert {
  accountId: string
  folderId: string
  uid: number
  messageIdHeader?: string
  inReplyTo?: string
  references: string[]
  /** Gmail X-GM-THRID when available; store uses it as the thread key */
  gmThrid?: string
  gmMsgid?: string
  subject: string
  from: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo: EmailAddress[]
  date: number
  internalDate?: number
  snippet?: string
  flags: MessageFlags
  hasAttachments: boolean
  size: number
  labels?: string[]
  /** Present when the body was fetched in the same pass */
  body?: MessageBody
}

export interface MessageBody {
  html?: string
  text?: string
  headers: Record<string, string>
  attachments: Omit<AttachmentMeta, 'id' | 'messageId' | 'localPath'>[]
}

export interface FolderUpsert {
  accountId: string
  path: string
  name: string
  delimiter: string
  kind: FolderKind
  synced?: boolean
}

export interface FolderSyncState {
  uidValidity?: number
  uidNext?: number
  highestModseq?: string
  /** Lowest UID we have backfilled to (for progressive history download) */
  lowestUid?: number
  lastFullFlagSyncAt?: number
}

export interface PendingAction {
  id: string
  accountId: string
  request: MessageActionRequest
  /** uid + folder per message captured at enqueue time, so it survives local deletes */
  targets: { messageId: string; folderId: string; uid: number }[]
  createdAt: number
  attempts: number
  lastError?: string
}

export interface OutboxItem {
  id: string
  accountId: string
  payload: ComposePayload
  createdAt: number
  attempts: number
  lastError?: string
  status: 'queued' | 'sending' | 'failed'
}

export interface MailStore {
  /** Open/create the database at the given path and run migrations. */
  open(dbPath: string): void
  close(): void

  // Accounts ---------------------------------------------------------------
  listAccounts(): Account[]
  getAccount(id: string): Account | undefined
  /** Stores secrets encrypted with Electron safeStorage. Returns the public Account. */
  addAccount(input: AccountInput): Account
  updateAccount(id: string, patch: Partial<AccountInput> & Partial<Pick<Account, 'lastSyncAt' | 'lastError' | 'enabled'>>): Account
  removeAccount(id: string): void
  /** Decrypted secret for connecting. Never send to the renderer. */
  getAccountSecret(id: string): { password?: string; oauth?: OAuthTokens } | undefined
  setAccountOAuth(id: string, tokens: OAuthTokens): void

  // Folders ----------------------------------------------------------------
  listFolders(accountId?: string): Folder[]
  getFolder(id: string): Folder | undefined
  getFolderByPath(accountId: string, path: string): Folder | undefined
  getFolderByKind(accountId: string, kind: FolderKind): Folder | undefined
  /** Upserts the full folder list for an account; folders missing from `folders` are deleted. */
  replaceFolders(accountId: string, folders: FolderUpsert[]): Folder[]
  updateFolderCounts(folderId: string, counts: { unreadCount?: number; totalCount?: number }): void
  getFolderSyncState(folderId: string): FolderSyncState
  setFolderSyncState(folderId: string, state: FolderSyncState): void
  /** Wipe messages for a folder (UIDVALIDITY changed) */
  clearFolder(folderId: string): void

  // Messages ---------------------------------------------------------------
  /** Insert or update by (folderId, uid). Assigns thread ids. Returns stored summary and whether it was new. */
  upsertMessage(msg: MessageUpsert): { message: MessageSummary; isNew: boolean }
  upsertMessages(msgs: MessageUpsert[]): { message: MessageSummary; isNew: boolean }[]
  setMessageBody(messageId: string, body: MessageBody): void
  updateFlags(folderId: string, uid: number, flags: Partial<MessageFlags>): void
  updateFlagsBulk(updates: { folderId: string; uid: number; flags: Partial<MessageFlags> }[]): void
  /** Remove messages whose UIDs are no longer in the folder */
  deleteByUids(folderId: string, uids: number[]): void
  /** Keep only UIDs in the set for the given range; used after a full UID listing */
  reconcileUids(folderId: string, presentUids: number[], minUid: number): { removed: number }
  /** Local move (updates folderId/uid). Used after a successful IMAP MOVE. */
  moveMessage(messageId: string, targetFolderId: string, newUid?: number): void
  getMessage(messageId: string): MessageFull | undefined
  getMessageSummary(messageId: string): MessageSummary | undefined
  getMessageByUid(folderId: string, uid: number): MessageSummary | undefined
  getMessageByHeaderId(accountId: string, messageIdHeader: string): MessageSummary | undefined
  listUids(folderId: string): number[]
  /** Messages in a folder lacking bodies, newest first (for body prefetch) */
  listMessagesWithoutBody(folderId: string, limit: number): MessageSummary[]
  /** Real (positive) UIDs in a folder whose list preview is still empty, newest first */
  listUidsWithoutSnippet(folderId: string, limit: number): number[]
  /** Set preview text for messages by (folder, uid); no-op for unknown rows */
  setSnippets(updates: { folderId: string; uid: number; snippet: string }[]): void
  listMessages(query: MessageListQuery): MessageListResult
  getThread(threadId: string): MessageFull[]
  getThreadSummary(threadId: string): ThreadSummary | undefined
  search(query: SearchQuery): MessageListResult
  unreadCounts(): import('@shared/types').UnreadCounts
  suggestContacts(q: string, limit: number): { name?: string; address: string; count: number }[]

  // Attachments ------------------------------------------------------------
  getAttachment(attachmentId: string): AttachmentMeta | undefined
  setAttachmentLocalPath(attachmentId: string, localPath: string): void

  // Drafts / outbox / pending actions ---------------------------------------
  saveDraft(payload: ComposePayload, remoteUid?: number): Draft
  getDraft(draftId: string): Draft | undefined
  listDrafts(accountId?: string): Draft[]
  deleteDraft(draftId: string): void
  enqueueAction(action: Omit<PendingAction, 'id' | 'createdAt' | 'attempts'>): PendingAction
  listPendingActions(accountId: string): PendingAction[]
  completeAction(id: string): void
  failAction(id: string, error: string): void
  enqueueOutbox(payload: ComposePayload): OutboxItem
  listOutbox(accountId?: string): OutboxItem[]
  updateOutbox(id: string, patch: Partial<Pick<OutboxItem, 'status' | 'attempts' | 'lastError'>>): void
  deleteOutbox(id: string): void

  // Settings ---------------------------------------------------------------
  getSettings(): AppSettings
  setSettings(patch: Partial<AppSettings>): AppSettings
}

// ---------------------------------------------------------------------------
// Mail engine (IMAP / SMTP)
// ---------------------------------------------------------------------------

export interface MailEngineEvents {
  newMail: (accountId: string, messages: MessageSummary[]) => void
  changed: (event: import('@shared/types').MailChangedEvent) => void
  status: (status: SyncStatus) => void
  authError: (event: import('@shared/types').AccountAuthErrorEvent) => void
  foldersChanged: (accountId: string) => void
}

export interface MailEngine {
  on<E extends keyof MailEngineEvents>(event: E, handler: MailEngineEvents[E]): () => void
  /** Connect all enabled accounts, start IDLE + polling. Idempotent. */
  start(): Promise<void>
  stop(): Promise<void>
  /** Start (or restart) syncing one account; call after add/update/reauth. */
  startAccount(accountId: string): Promise<void>
  stopAccount(accountId: string): Promise<void>
  /** Force a sync pass now. */
  syncNow(accountId?: string): Promise<void>
  getStatus(): SyncStatus[]
  /** Fetch the body (and attachment metadata) for a message if not cached. */
  ensureBody(messageId: string): Promise<MessageFull>
  /** Download an attachment to the cache dir; returns meta with localPath. */
  downloadAttachment(attachmentId: string): Promise<AttachmentMeta>
  /** Raw RFC822 source */
  fetchRaw(messageId: string): Promise<string>
  /** Apply an action locally immediately, then to the server (queued if offline). */
  applyAction(request: MessageActionRequest): Promise<void>
  /** Send via SMTP, append to Sent when the server does not do it, set \Answered on originals. */
  send(payload: ComposePayload): Promise<void>
  /** Upload a draft to the IMAP Drafts folder (replacing any earlier upload). */
  saveDraftRemote(draft: Draft): Promise<Draft>
  /** Test connectivity without saving anything. */
  testConnection(input: AccountInput): Promise<ConnectionTestResult>
  createFolder(accountId: string, name: string, parentPath?: string): Promise<Folder>
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthService {
  presets(): ProviderPreset[]
  presetForEmail(email: string): ProviderPreset | undefined
  /** ISPDB autoconfig + DNS SRV + preset lookup */
  autodetect(email: string): Promise<{ imap?: ServerSettings; smtp?: ServerSettings; provider?: string } | null>
  /** Open the system browser, run the loopback OAuth flow, exchange the code. */
  startOAuth(req: OAuthStartRequest, onProgress?: (step: string, message?: string) => void): Promise<OAuthResult>
  cancelOAuth(): void
  /** Refresh if expiring within 60s. Returns fresh tokens (caller persists them). */
  ensureFreshTokens(tokens: OAuthTokens): Promise<OAuthTokens>
  /** Build the SASL XOAUTH2 initial client response (base64) */
  xoauth2(user: string, accessToken: string): string
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface AppPaths {
  userData: string
  dbFile: string
  attachmentsDir: string
  logsDir: string
}
