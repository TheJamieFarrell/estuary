/**
 * IPC contract between renderer and main.
 * Renderer calls `window.api.invoke(channel, payload)`; main pushes `window.api.on(event, handler)`.
 * Both sides import the channel names from here so typos are compile errors.
 */
import type {
  Account,
  AccountInput,
  AccountAuthErrorEvent,
  AppSettings,
  AttachmentMeta,
  ComposePayload,
  ConnectionTestResult,
  Draft,
  Folder,
  MailChangedEvent,
  MessageActionRequest,
  MessageFull,
  MessageListQuery,
  MessageListResult,
  NewMailEvent,
  OAuthResult,
  OAuthStartRequest,
  ProviderPreset,
  SearchQuery,
  ServerSettings,
  SyncStatus,
  ThreadSummary,
  UnreadCounts
} from './types'

/** Request/response channels (renderer -> main, awaits a result). */
export interface IpcInvokeMap {
  // Accounts
  'accounts:list': { req: void; res: Account[] }
  'accounts:add': { req: AccountInput; res: Account }
  'accounts:update': { req: { id: string; patch: Partial<AccountInput> }; res: Account }
  'accounts:remove': { req: { id: string }; res: void }
  'accounts:test': { req: AccountInput; res: ConnectionTestResult }
  'accounts:presets': { req: void; res: ProviderPreset[] }
  /** Guess IMAP/SMTP settings for an address (presets, ISPDB autoconfig, DNS SRV) */
  'accounts:autodetect': { req: { email: string }; res: { imap?: ServerSettings; smtp?: ServerSettings; provider?: string } | null }
  /** Re-run OAuth for an existing account whose refresh token died */
  'accounts:reauth': { req: { id: string }; res: OAuthResult }

  // OAuth
  'auth:oauthStart': { req: OAuthStartRequest; res: OAuthResult }
  'auth:oauthCancel': { req: void; res: void }

  // Folders
  'folders:list': { req: { accountId?: string }; res: Folder[] }
  'folders:create': { req: { accountId: string; name: string; parentPath?: string }; res: Folder }
  'folders:unreadCounts': { req: void; res: UnreadCounts }

  // Messages / threads
  'messages:list': { req: MessageListQuery; res: MessageListResult }
  'messages:get': { req: { messageId: string }; res: MessageFull }
  'messages:thread': { req: { threadId: string }; res: MessageFull[] }
  'messages:threadSummary': { req: { threadId: string }; res: ThreadSummary | null }
  'messages:action': { req: MessageActionRequest; res: void }
  /** Fetch the raw RFC822 source (for "view source" / .eml export) */
  'messages:raw': { req: { messageId: string }; res: string }
  /** Download to cache; returns updated meta with localPath */
  'attachments:download': { req: { attachmentId: string }; res: AttachmentMeta }
  /** Download then show a Save As dialog */
  'attachments:saveAs': { req: { attachmentId: string }; res: { saved: boolean; path?: string } }
  /** Download then open with the default app */
  'attachments:open': { req: { attachmentId: string }; res: void }
  /** Returns a data: URL for an inline (cid:) image */
  'attachments:inlineDataUrl': { req: { attachmentId: string }; res: string }

  // Search
  'search:query': { req: SearchQuery; res: MessageListResult }

  // Compose / drafts
  'compose:send': { req: ComposePayload; res: { ok: boolean; error?: string } }
  'drafts:save': { req: ComposePayload; res: Draft }
  'drafts:list': { req: { accountId?: string }; res: Draft[] }
  'drafts:get': { req: { draftId: string }; res: Draft | null }
  'drafts:delete': { req: { draftId: string }; res: void }
  /** Open a compose window. mode/inReplyTo pre-fill it. */
  'compose:open': {
    req: { accountId?: string; mode?: 'new' | 'reply' | 'replyAll' | 'forward'; messageId?: string; draftId?: string; mailto?: string }
    res: void
  }
  /** Compose windows call this to get their initial payload */
  'compose:init': { req: void; res: { payload: ComposePayload; accounts: Account[]; original?: MessageFull } }
  'compose:pickFiles': { req: void; res: { path: string; filename: string; size: number; contentType: string }[] }

  // Sync
  'sync:now': { req: { accountId?: string }; res: void }
  'sync:status': { req: void; res: SyncStatus[] }

  // Settings / app
  'settings:get': { req: void; res: AppSettings }
  'settings:set': { req: Partial<AppSettings>; res: AppSettings }
  'app:openExternal': { req: { url: string }; res: void }
  'app:showItemInFolder': { req: { path: string }; res: void }
  'app:version': { req: void; res: { version: string; electron: string; platform: string } }
  'app:pickDirectory': { req: void; res: string | null }
  /** Contact autocomplete from previously seen addresses */
  'contacts:suggest': { req: { q: string; limit?: number }; res: { name?: string; address: string; count: number }[] }
}

export type IpcChannel = keyof IpcInvokeMap
export type IpcReq<C extends IpcChannel> = IpcInvokeMap[C]['req']
export type IpcRes<C extends IpcChannel> = IpcInvokeMap[C]['res']

/** Push events (main -> renderer). */
export interface IpcEventMap {
  'mail:new': NewMailEvent
  'mail:changed': MailChangedEvent
  'sync:status': SyncStatus
  'account:authError': AccountAuthErrorEvent
  'accounts:changed': { accounts: Account[] }
  'folders:changed': { accountId: string }
  'settings:changed': AppSettings
  'oauth:progress': { step: 'waitingForBrowser' | 'exchanging' | 'done' | 'error'; message?: string }
  /** main asks the renderer to navigate (tray click, notification click) */
  'nav:goto': { view: 'inbox' | 'thread' | 'settings' | 'accounts'; threadId?: string; accountId?: string }
  /** compose window only: main asks the window to close after a successful send */
  'compose:close': void
}

export type IpcEvent = keyof IpcEventMap
export type IpcEventPayload<E extends IpcEvent> = IpcEventMap[E]

/** Shape exposed on window.api by the preload script. */
export interface RendererApi {
  invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>>
  on<E extends IpcEvent>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void
  /** Which html this window is: main app or compose */
  windowKind: 'main' | 'compose'
  platform: string
}

declare global {
  interface Window {
    api: RendererApi
  }
}
