/**
 * Every `IpcInvokeMap` channel is registered here, plus the engine -> renderer event pump.
 * Handlers stay thin: they translate an IPC request into store/engine/auth calls and
 * do the bits that need Electron itself (dialogs, shell, the tray badge).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import log from 'electron-log/main'
import type {
  Account,
  ComposePayload,
  EmailAddress,
  MessageFull,
  OAuthProvider,
  OAuthStartRequest
} from '@shared/types'
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcReq, IpcRes } from '@shared/ipc'
import type { AppPaths, AuthService, MailEngine, MailStore } from '@main/contracts'
import type { ComposeInit, WindowManager } from '@main/windows'
import { openExternalIfSafe } from '@main/windows'
import type { TrayController } from '@main/tray'
import type { Notifier } from '@main/notifications'
import type { Updater } from '@main/updater'
import { applyLoginItem } from '@main/loginItem'
import { accountAttachmentsDir } from '@main/paths'

const scope = log.scope('ipc')

export interface IpcDeps {
  store: MailStore
  engine: MailEngine
  auth: AuthService
  windows: WindowManager
  paths: AppPaths
  tray: TrayController
  notifier: Notifier
  updater: Updater
}

export interface IpcController {
  /** Recompute unread counts and push them to the tray. */
  refreshUnread(): void
  broadcast<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip'
}

function mimeFor(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address
}

function formatAddressList(list: EmailAddress[]): string {
  return list.map(formatAddress).join(', ')
}

/** Drop duplicates (case-insensitive) and any address in `exclude`. */
function dedupeAddresses(list: EmailAddress[], exclude: Set<string>): EmailAddress[] {
  const seen = new Set<string>()
  const out: EmailAddress[] = []
  for (const entry of list) {
    const key = entry?.address?.trim().toLowerCase()
    if (!key || seen.has(key) || exclude.has(key)) continue
    seen.add(key)
    out.push({ name: entry.name, address: entry.address.trim() })
  }
  return out
}

/** "Re: Re: RE: hi" -> "hi" */
function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(\s*(re|fwd|fw)\s*(\[\d+\])?\s*:\s*)+/i, '').trim()
}

function withPrefix(prefix: 'Re' | 'Fwd', subject: string): string {
  const base = stripSubjectPrefixes(subject || '')
  return base ? `${prefix}: ${base}` : `${prefix}:`
}

function parseAddressList(value: string): EmailAddress[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(part)
      if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim() || undefined, address: match[2].trim() }
      return { address: part }
    })
}

interface MailtoParts {
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject?: string
  body?: string
}

function parseMailto(value: string): MailtoParts {
  const empty: MailtoParts = { to: [], cc: [], bcc: [] }
  try {
    const raw = value.startsWith('mailto:') ? value : `mailto:${value}`
    const url = new URL(raw)
    const target = decodeURIComponent(url.pathname)
    const params = url.searchParams
    return {
      to: parseAddressList(target),
      cc: parseAddressList(params.get('cc') ?? ''),
      bcc: parseAddressList(params.get('bcc') ?? ''),
      subject: params.get('subject') ?? undefined,
      body: params.get('body') ?? undefined
    }
  } catch {
    scope.warn('could not parse mailto url')
    return empty
  }
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

function originalBodyHtml(original: MessageFull): string {
  if (original.html) return original.html
  if (original.text) return textToHtml(original.text)
  return ''
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return new Date(ms).toISOString()
  }
}

function buildQuote(original: MessageFull): string {
  const attribution = `On ${escapeHtml(formatDate(original.date))}, ${escapeHtml(
    formatAddressList(original.from) || 'someone'
  )} wrote:`
  return `<br><br><div class="unimail-quote">${attribution}<blockquote>${originalBodyHtml(original)}</blockquote></div>`
}

function buildForwardBlock(original: MessageFull): string {
  const rows = [
    `From: ${escapeHtml(formatAddressList(original.from))}`,
    `Date: ${escapeHtml(formatDate(original.date))}`,
    `Subject: ${escapeHtml(original.subject || '(no subject)')}`,
    `To: ${escapeHtml(formatAddressList(original.to))}`
  ]
  if (original.cc.length) rows.push(`Cc: ${escapeHtml(formatAddressList(original.cc))}`)
  return (
    '<br><br><div class="unimail-quote">---------- Forwarded message ----------<br>' +
    rows.join('<br>') +
    `<br><br>${originalBodyHtml(original)}</div>`
  )
}

function oauthProviderFor(account: Account): OAuthProvider | undefined {
  if (account.provider === 'gmail') return 'google'
  if (account.provider === 'outlook') return 'microsoft'
  return undefined
}

function sendTo<E extends IpcEvent>(target: WebContents, event: E, payload: IpcEventPayload<E>): void {
  if (!target.isDestroyed()) target.send(event, payload)
}

// ---------------------------------------------------------------------------

export function registerIpc(deps: IpcDeps): IpcController {
  const { store, engine, auth, windows, paths, tray, notifier, updater } = deps

  // -- broadcast + unread -----------------------------------------------------

  function broadcast<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    windows.broadcast(event, payload)
  }

  let unreadTimer: NodeJS.Timeout | undefined
  function refreshUnread(): void {
    clearTimeout(unreadTimer)
    unreadTimer = setTimeout(() => {
      try {
        tray.setUnread(store.unreadCounts().inbox)
      } catch (err) {
        scope.warn('unread refresh failed', err)
      }
    }, 150)
  }

  function broadcastAccounts(): void {
    try {
      broadcast('accounts:changed', { accounts: store.listAccounts() })
    } catch (err) {
      scope.warn('could not broadcast accounts', err)
    }
  }

  // -- typed handler registration ---------------------------------------------

  const registered: IpcChannel[] = []

  function handle<C extends IpcChannel>(
    channel: C,
    fn: (req: IpcReq<C>, event: IpcMainInvokeEvent) => Promise<IpcRes<C>> | IpcRes<C>
  ): void {
    ipcMain.removeHandler(channel)
    registered.push(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, req: unknown) => {
      try {
        return await fn(req as IpcReq<C>, event)
      } catch (err) {
        scope.error(`${channel} failed`, err)
        // Errors crossing IPC must be plain, user-readable Errors.
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  // -- accounts ---------------------------------------------------------------

  handle('accounts:list', () => store.listAccounts())

  handle('accounts:add', (input) => {
    const account = store.addAccount(input)
    // The first sync of a brand-new account would otherwise fire a notification per message.
    notifier.markAccountAdded(account.id)
    void engine.startAccount(account.id).catch((err) => scope.warn('startAccount after add failed', err))
    broadcastAccounts()
    refreshUnread()
    return account
  })

  handle('accounts:update', async ({ id, patch }) => {
    const before = store.getAccount(id)
    const account = store.updateAccount(id, patch)
    const serverChanged =
      !!patch.password ||
      !!patch.oauth ||
      (patch.username !== undefined && patch.username !== before?.username) ||
      (patch.authType !== undefined && patch.authType !== before?.authType) ||
      (!!patch.imap && JSON.stringify(patch.imap) !== JSON.stringify(before?.imap)) ||
      (!!patch.smtp && JSON.stringify(patch.smtp) !== JSON.stringify(before?.smtp))
    if (serverChanged) {
      try {
        await engine.stopAccount(id)
      } catch (err) {
        scope.warn('stopAccount during update failed', err)
      }
      void engine.startAccount(id).catch((err) => scope.warn('startAccount during update failed', err))
    }
    broadcastAccounts()
    return account
  })

  handle('accounts:remove', async ({ id }) => {
    try {
      await engine.stopAccount(id)
    } catch (err) {
      scope.warn('stopAccount during remove failed', err)
    }
    store.removeAccount(id)
    notifier.markAccountRemoved(id)
    try {
      rmSync(accountAttachmentsDir(paths, id), { recursive: true, force: true })
    } catch (err) {
      scope.warn('could not remove cached attachments', err)
    }
    broadcastAccounts()
    refreshUnread()
  })

  handle('accounts:test', (input) => engine.testConnection(input))
  handle('accounts:presets', () => auth.presets())
  handle('accounts:autodetect', ({ email }) => auth.autodetect(email))

  handle('accounts:reauth', async ({ id }, event) => {
    const account = store.getAccount(id)
    if (!account) throw new Error('That account no longer exists.')
    const provider = oauthProviderFor(account)
    if (!provider) throw new Error(`${account.email} does not use OAuth sign-in.`)

    // Reuse whatever client credentials the account was created with, falling back to
    // the ones saved in Settings.
    const existing = store.getAccountSecret(id)?.oauth
    const configured = store.getSettings().oauthClients[provider]
    const clientId = existing?.clientId ?? configured?.clientId
    const clientSecret = existing?.clientSecret ?? configured?.clientSecret
    if (!clientId) throw new Error(`No OAuth client id is configured for ${provider}. Add one in Settings.`)

    const request: OAuthStartRequest = { provider, clientId, clientSecret, email: account.email }
    const result = await auth.startOAuth(request, (step, message) =>
      sendTo(event.sender, 'oauth:progress', {
        step: step as IpcEventPayload<'oauth:progress'>['step'],
        message
      })
    )
    if (result.ok && result.tokens) {
      store.setAccountOAuth(id, result.tokens)
      void engine.startAccount(id).catch((err) => scope.warn('startAccount after reauth failed', err))
      broadcastAccounts()
    }
    return result
  })

  // -- oauth ------------------------------------------------------------------

  handle('auth:oauthStart', (req, event) =>
    auth.startOAuth(req, (step, message) =>
      sendTo(event.sender, 'oauth:progress', {
        step: step as IpcEventPayload<'oauth:progress'>['step'],
        message
      })
    )
  )

  handle('auth:oauthCancel', () => auth.cancelOAuth())

  // -- folders ----------------------------------------------------------------

  handle('folders:list', ({ accountId }) => store.listFolders(accountId))
  handle('folders:create', ({ accountId, name, parentPath }) => engine.createFolder(accountId, name, parentPath))
  handle('folders:unreadCounts', () => store.unreadCounts())

  // -- messages ---------------------------------------------------------------

  handle('messages:list', (query) => store.listMessages(query))
  handle('messages:get', ({ messageId }) => engine.ensureBody(messageId))
  handle('messages:thread', ({ threadId }) => store.getThread(threadId))
  handle('messages:threadSummary', ({ threadId }) => store.getThreadSummary(threadId) ?? null)

  handle('messages:action', async (request) => {
    await engine.applyAction(request)
    refreshUnread()
  })

  handle('messages:raw', ({ messageId }) => engine.fetchRaw(messageId))

  // -- attachments ------------------------------------------------------------

  async function ensureDownloaded(attachmentId: string): Promise<{ path: string; filename: string; contentType: string }> {
    const meta = await engine.downloadAttachment(attachmentId)
    if (!meta.localPath) throw new Error(`Could not download "${meta.filename}".`)
    return { path: meta.localPath, filename: meta.filename, contentType: meta.contentType }
  }

  handle('attachments:download', ({ attachmentId }) => engine.downloadAttachment(attachmentId))

  handle('attachments:open', async ({ attachmentId }) => {
    const file = await ensureDownloaded(attachmentId)
    const error = await shell.openPath(file.path)
    if (error) throw new Error(error)
  })

  handle('attachments:saveAs', async ({ attachmentId }, event) => {
    const file = await ensureDownloaded(attachmentId)
    const baseDir = store.getSettings().downloadDir || app.getPath('downloads')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Save attachment',
      defaultPath: join(baseDir, file.filename || basename(file.path)),
      buttonLabel: 'Save'
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false }
    await copyFile(file.path, result.filePath)
    return { saved: true, path: result.filePath }
  })

  handle('attachments:inlineDataUrl', async ({ attachmentId }) => {
    const file = await ensureDownloaded(attachmentId)
    const data = await readFile(file.path)
    return `data:${file.contentType || 'application/octet-stream'};base64,${data.toString('base64')}`
  })

  // -- search -----------------------------------------------------------------

  handle('search:query', (query) => store.search(query))

  // -- compose / drafts -------------------------------------------------------

  handle('compose:send', async (payload, event) => {
    try {
      await engine.send(payload)
    } catch (err) {
      scope.error('send failed', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (payload.draftId) {
      try {
        store.deleteDraft(payload.draftId)
      } catch (err) {
        scope.warn('could not delete draft after send', err)
      }
    }
    sendTo(event.sender, 'compose:close', undefined)
    refreshUnread()
    return { ok: true }
  })

  handle('drafts:save', (payload) => {
    const draft = store.saveDraft(payload)
    // Uploading to the IMAP Drafts folder is best-effort; the local copy is authoritative.
    void engine.saveDraftRemote(draft).catch((err) => scope.warn('remote draft save failed', err))
    return draft
  })

  handle('drafts:list', ({ accountId }) => store.listDrafts(accountId))
  handle('drafts:get', ({ draftId }) => store.getDraft(draftId) ?? null)
  handle('drafts:delete', ({ draftId }) => store.deleteDraft(draftId))

  handle('compose:open', (init) => {
    windows.createComposeWindow(init)
  })

  handle('compose:init', (_req, event) => {
    const init = windows.composeInitFor(event.sender.id) ?? {}
    return buildComposeInit(init)
  })

  handle('compose:pickFiles', async (_req, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const files: { path: string; filename: string; size: number; contentType: string }[] = []
    for (const filePath of result.filePaths) {
      try {
        const info = await stat(filePath)
        files.push({
          path: filePath,
          filename: basename(filePath),
          size: info.size,
          contentType: mimeFor(filePath)
        })
      } catch (err) {
        scope.warn(`could not stat ${filePath}`, err)
      }
    }
    return files
  })

  /** Assemble the payload a compose window opens with. */
  async function buildComposeInit(
    init: ComposeInit
  ): Promise<{ payload: ComposePayload; accounts: Account[]; original?: MessageFull }> {
    const accounts = store.listAccounts()

    let original: MessageFull | undefined
    if (init.messageId) {
      try {
        original = await engine.ensureBody(init.messageId)
      } catch (err) {
        scope.warn('could not load the original message for compose', err)
      }
    }

    // Editing a saved draft: hand back exactly what was saved.
    if (init.draftId) {
      const draft = store.getDraft(init.draftId)
      if (draft) return { payload: { ...draft.payload, draftId: draft.id }, accounts, original }
      scope.warn(`draft ${init.draftId} is gone; opening a blank compose window`)
    }

    const accountId = init.accountId ?? original?.accountId ?? accounts[0]?.id ?? ''
    const account = accounts.find((a) => a.id === accountId)
    const signature = account?.signature ? `<br><br>${account.signature}` : ''
    const own = new Set<string>()
    if (account?.email) own.add(account.email.toLowerCase())

    const mode = init.mode ?? (original ? 'reply' : 'new')
    const base: ComposePayload = {
      accountId,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      html: '',
      attachments: [],
      mode: 'new'
    }

    if (original && (mode === 'reply' || mode === 'replyAll')) {
      const primary = original.replyTo.length ? original.replyTo : original.from
      const to = mode === 'replyAll' ? [...primary, ...original.to] : primary
      return {
        payload: {
          ...base,
          mode,
          to: dedupeAddresses(to, own),
          cc: mode === 'replyAll' ? dedupeAddresses(original.cc, own) : [],
          subject: withPrefix('Re', original.subject),
          html: `<p><br></p>${signature}${buildQuote(original)}`,
          inReplyToMessageId: original.id
        },
        accounts,
        original
      }
    }

    if (original && mode === 'forward') {
      // Re-attach the original files by pulling them out of the attachment cache first.
      const attachments: ComposePayload['attachments'] = []
      for (const meta of original.attachments) {
        try {
          const downloaded = await engine.downloadAttachment(meta.id)
          if (!downloaded.localPath) continue
          attachments.push({
            filename: downloaded.filename,
            contentType: downloaded.contentType,
            path: downloaded.localPath,
            size: downloaded.size,
            contentId: downloaded.isInline ? downloaded.contentId : undefined
          })
        } catch (err) {
          scope.warn(`could not re-attach "${meta.filename}"`, err)
        }
      }
      return {
        payload: {
          ...base,
          mode: 'forward',
          subject: withPrefix('Fwd', original.subject),
          html: `<p><br></p>${signature}${buildForwardBlock(original)}`,
          attachments,
          inReplyToMessageId: original.id
        },
        accounts,
        original
      }
    }

    if (init.mailto) {
      const parts = parseMailto(init.mailto)
      return {
        payload: {
          ...base,
          to: dedupeAddresses(parts.to, new Set()),
          cc: dedupeAddresses(parts.cc, new Set()),
          bcc: dedupeAddresses(parts.bcc, new Set()),
          subject: parts.subject ?? '',
          html: `<p>${parts.body ? textToHtml(parts.body) : '<br>'}</p>${signature}`
        },
        accounts,
        original
      }
    }

    return { payload: { ...base, html: `<p><br></p>${signature}` }, accounts, original }
  }

  // -- sync -------------------------------------------------------------------

  handle('sync:now', ({ accountId }) => engine.syncNow(accountId))
  handle('sync:status', () => engine.getStatus())

  // -- settings / app ---------------------------------------------------------

  handle('settings:get', () => store.getSettings())

  handle('settings:set', (patch) => {
    const settings = store.setSettings(patch)
    if (patch.theme !== undefined) windows.applyTheme(settings.theme)
    if (patch.startOnLogin !== undefined) applyLoginItem(settings.startOnLogin)
    tray.refresh()
    broadcast('settings:changed', settings)
    return settings
  })

  handle('app:openExternal', ({ url }) => {
    openExternalIfSafe(url)
  })

  handle('app:showItemInFolder', ({ path }) => {
    shell.showItemInFolder(path)
  })

  handle('app:version', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    logPath: paths.logsDir
  }))

  handle('update:check', () => updater.check())
  handle('update:install', () => updater.install())

  handle('app:pickDirectory', async (_req, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose a download folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })

  handle('contacts:suggest', ({ q, limit }) => store.suggestContacts(q, limit ?? 8))

  // -- engine -> renderer -----------------------------------------------------

  const unsubscribes: Array<() => void> = [
    engine.on('newMail', (accountId, messages) => {
      notifier.notifyNewMail(accountId, messages)
      broadcast('mail:new', { accountId, messages })
      refreshUnread()
    }),
    engine.on('changed', (event) => {
      broadcast('mail:changed', event)
      refreshUnread()
    }),
    engine.on('status', (status) => {
      notifier.noteStatus(status)
      broadcast('sync:status', status)
    }),
    engine.on('authError', (event) => {
      broadcast('account:authError', event)
    }),
    engine.on('foldersChanged', (accountId) => {
      broadcast('folders:changed', { accountId })
    })
  ]

  refreshUnread()

  return {
    refreshUnread,
    broadcast,
    dispose() {
      clearTimeout(unreadTimer)
      for (const off of unsubscribes) {
        try {
          off()
        } catch {
          /* engine already torn down */
        }
      }
      for (const channel of registered) ipcMain.removeHandler(channel)
      registered.length = 0
    }
  }
}
