/**
 * UniMail shared domain types.
 * This file is the CONTRACT between main-process modules and the renderer.
 * All agents build against these types. Add fields freely, but do not rename or remove
 * anything without updating every consumer.
 */

export type ProviderId = 'gmail' | 'outlook' | 'spacemail' | 'icloud' | 'yahoo' | 'fastmail' | 'imap'

export type AuthType = 'password' | 'oauth2'

export type OAuthProvider = 'google' | 'microsoft'

export interface ServerSettings {
  host: string
  port: number
  /** true = implicit TLS (993/465), false = STARTTLS or plain (143/587) */
  secure: boolean
}

export interface Account {
  id: string
  email: string
  /** Display name used in From: */
  name: string
  provider: ProviderId
  authType: AuthType
  imap: ServerSettings
  smtp: ServerSettings
  /** IMAP/SMTP login. Usually the email address. */
  username: string
  /** Accent colour used for the account chip in the unified list (hex). */
  color: string
  /** Optional signature HTML appended to new messages */
  signature?: string
  createdAt: number
  lastSyncAt?: number
  /** Non-fatal status message from the last sync/connect attempt */
  lastError?: string
  /** Max messages to keep per folder in the local cache (0 = unlimited) */
  cacheLimit: number
  enabled: boolean
}

/** Everything needed to create an account. Secrets travel over IPC once and are stored encrypted. */
export interface AccountInput {
  email: string
  name: string
  provider: ProviderId
  authType: AuthType
  imap: ServerSettings
  smtp: ServerSettings
  username: string
  /** Plain password or app password (authType === 'password') */
  password?: string
  /** Tokens obtained by the OAuth flow (authType === 'oauth2') */
  oauth?: OAuthTokens
  color?: string
  signature?: string
  cacheLimit?: number
}

export interface OAuthTokens {
  provider: OAuthProvider
  clientId: string
  /** Google desktop clients have a (non-secret) client secret; Microsoft public clients do not. */
  clientSecret?: string
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
  scope: string
  /** Email address reported by the provider's userinfo endpoint */
  email?: string
}

export type FolderKind =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'all' // Gmail "[Gmail]/All Mail"
  | 'starred' // Gmail "[Gmail]/Starred" (virtual on other providers)
  | 'important'
  | 'custom'

export interface Folder {
  id: string
  accountId: string
  /** Full IMAP path, e.g. "[Gmail]/All Mail" or "INBOX.Archive" */
  path: string
  /** Leaf display name */
  name: string
  delimiter: string
  kind: FolderKind
  unreadCount: number
  totalCount: number
  /** Whether the sync engine keeps this folder up to date */
  synced: boolean
}

export interface EmailAddress {
  name?: string
  address: string
}

export interface AttachmentMeta {
  id: string
  messageId: string
  filename: string
  contentType: string
  size: number
  contentId?: string
  isInline: boolean
  /** IMAP body part id, used to fetch on demand */
  partId: string
  /** Set once downloaded to the attachments cache directory */
  localPath?: string
}

export interface MessageFlags {
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  forwarded: boolean
}

/** Envelope-level data. Cheap; used in list views. */
export interface MessageSummary {
  id: string
  accountId: string
  folderId: string
  threadId: string
  uid: number
  /** RFC Message-ID header, angle brackets stripped */
  messageIdHeader?: string
  subject: string
  from: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo: EmailAddress[]
  /** epoch ms of the Date header (falls back to INTERNALDATE) */
  date: number
  snippet: string
  flags: MessageFlags
  hasAttachments: boolean
  size: number
  /** Gmail labels when available */
  labels: string[]
  bodyFetched: boolean
}

/** Full message including bodies. Fetched on open. */
export interface MessageFull extends MessageSummary {
  html?: string
  text?: string
  inReplyTo?: string
  references: string[]
  attachments: AttachmentMeta[]
  /** Selected raw headers (list-unsubscribe, etc.) */
  headers: Record<string, string>
}

export interface ThreadSummary {
  id: string
  accountId: string
  subject: string
  /** Distinct senders/recipients, most recent first */
  participants: EmailAddress[]
  lastDate: number
  messageCount: number
  unreadCount: number
  hasStarred: boolean
  hasAttachments: boolean
  snippet: string
  /** Folder kinds this thread has messages in (e.g. ['inbox','sent']) */
  folderKinds: FolderKind[]
  /** ids of messages in the thread, oldest first */
  messageIds: string[]
  /** true if any message is a draft */
  hasDraft: boolean
}

/** What the renderer asks the list endpoint for. */
export interface MessageListQuery {
  /** Omit for unified view across all accounts */
  accountId?: string
  /** Filter to a specific folder id (takes precedence over folderKind) */
  folderId?: string
  /** Filter to a folder kind across accounts, e.g. 'inbox' for the unified inbox */
  folderKind?: FolderKind
  /** Only unread threads */
  unreadOnly?: boolean
  /** Only starred threads */
  starredOnly?: boolean
  /** Only threads with attachments */
  withAttachments?: boolean
  /** Page size (default 50) */
  limit?: number
  /** Opaque cursor from a previous page */
  cursor?: string
}

export interface MessageListResult {
  threads: ThreadSummary[]
  nextCursor?: string
  total?: number
}

export interface SearchQuery {
  /** Free text; supports FTS5 syntax plus operators from:, to:, subject:, has:attachment, is:unread, is:starred, before:, after: */
  q: string
  accountId?: string
  folderKind?: FolderKind
  limit?: number
  cursor?: string
}

export type MessageAction =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'trash'
  | 'deletePermanently'
  | 'spam'
  | 'notSpam'
  | 'move'

export interface MessageActionRequest {
  action: MessageAction
  messageIds: string[]
  /** required when action === 'move' */
  targetFolderId?: string
}

export interface ComposeAttachment {
  filename: string
  contentType: string
  /** Absolute path on disk (preferred, avoids copying through IPC) */
  path?: string
  /** Base64 content when the file only exists in memory (e.g. pasted image) */
  contentBase64?: string
  /** Set for inline images referenced as cid: in the html */
  contentId?: string
  size: number
}

export interface ComposePayload {
  /** Existing draft id if editing a saved draft */
  draftId?: string
  accountId: string
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  html: string
  text?: string
  attachments: ComposeAttachment[]
  /** Message being replied to / forwarded, so headers and flags are set correctly */
  inReplyToMessageId?: string
  mode?: 'new' | 'reply' | 'replyAll' | 'forward'
}

export interface Draft {
  id: string
  accountId: string
  payload: ComposePayload
  updatedAt: number
  /** UID of the draft in the IMAP Drafts folder once uploaded */
  remoteUid?: number
}

export type SyncState = 'idle' | 'connecting' | 'syncing' | 'listening' | 'error' | 'offline' | 'disabled'

export interface SyncStatus {
  accountId: string
  state: SyncState
  /** Human readable, e.g. "Syncing INBOX 240/1200" */
  detail?: string
  lastSyncAt?: number
  error?: string
  /** 0..1 for initial sync progress */
  progress?: number
}

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** Domains that auto-select this preset */
  domains: string[]
  imap: ServerSettings
  smtp: ServerSettings
  authTypes: AuthType[]
  /** For oauth2 providers */
  oauthProvider?: OAuthProvider
  /** Help text shown in the account wizard (e.g. how to create an app password) */
  help?: string
  helpUrl?: string
  /** Default cacheLimit */
  cacheLimit?: number
}

export interface OAuthStartRequest {
  provider: OAuthProvider
  clientId: string
  clientSecret?: string
  /** login_hint */
  email?: string
}

export interface OAuthResult {
  ok: boolean
  tokens?: OAuthTokens
  email?: string
  error?: string
}

export interface ConnectionTestResult {
  ok: boolean
  imap: { ok: boolean; error?: string; capabilities?: string[] }
  smtp: { ok: boolean; error?: string }
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  notificationsEnabled: boolean
  notificationSound: boolean
  startOnLogin: boolean
  minimizeToTray: boolean
  /** Load remote images automatically */
  loadRemoteImages: boolean
  /** Seconds between polls of non-IDLE folders */
  pollIntervalSec: number
  /** Mark as read after opening (ms). -1 = never, 0 = immediately */
  markReadDelayMs: number
  /** Directory attachments are saved into */
  downloadDir?: string
  /** Stored OAuth client credentials so the user only enters them once */
  oauthClients: Partial<Record<OAuthProvider, { clientId: string; clientSecret?: string }>>
  density: 'comfortable' | 'compact'
  /** Show unified view by default */
  defaultView: 'unified' | 'lastUsed'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  notificationsEnabled: true,
  notificationSound: true,
  startOnLogin: false,
  minimizeToTray: true,
  loadRemoteImages: false,
  pollIntervalSec: 300,
  markReadDelayMs: 1500,
  oauthClients: {},
  density: 'comfortable',
  defaultView: 'unified'
}

export interface UnreadCounts {
  /** total unread in unified inbox */
  inbox: number
  byAccount: Record<string, number>
  byFolder: Record<string, number>
}

/** Payload for a new-mail notification pushed to the renderer */
export interface NewMailEvent {
  accountId: string
  messages: MessageSummary[]
}

export interface MailChangedEvent {
  accountId: string
  folderId?: string
  /** If present, only these threads changed */
  threadIds?: string[]
  reason: 'sync' | 'action' | 'send' | 'delete'
}

export interface AccountAuthErrorEvent {
  accountId: string
  message: string
  /** true when the user must re-authenticate (expired refresh token, changed password) */
  needsReauth: boolean
}
