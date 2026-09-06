/**
 * UniMail mail engine: IMAP sync + IDLE, queued actions, SMTP sending, drafts.
 *
 *   const engine = createMailEngine(store, auth, paths)
 *   engine.on('newMail', ...)   // wire to notifications / IPC
 *   await engine.start()
 */
import log from 'electron-log/main'
import type {
  AccountInput,
  AttachmentMeta,
  ComposePayload,
  ConnectionTestResult,
  Draft,
  Folder,
  MessageActionRequest,
  MessageFull,
  SyncStatus
} from '@shared/types'
import type { AppPaths, AuthService, MailEngine, MailEngineEvents, MailStore } from '../contracts'
import { createActionRunner } from './actions'
import { createFetchService } from './attachments'
import { errorMessage } from './connection'
import { createDraftService } from './drafts'
import { buildFolderPath, detectInboxPrefixed } from './providers'
import { createSender } from './smtp'
import { AccountSyncer, type SyncDeps } from './sync'
import { testConnection } from './test'

const engineLog = log.scope('imap')

type AnyHandler = (...args: unknown[]) => void

class TypedEmitter {
  private readonly handlers = new Map<string, Set<AnyHandler>>()

  on<E extends keyof MailEngineEvents>(event: E, handler: MailEngineEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set<AnyHandler>()
    set.add(handler as unknown as AnyHandler)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as unknown as AnyHandler)
    }
  }

  emit<E extends keyof MailEngineEvents>(event: E, ...args: Parameters<MailEngineEvents[E]>): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of Array.from(set)) {
      try {
        handler(...(args as unknown[]))
      } catch (err) {
        engineLog.warn(`listener for ${String(event)} threw: ${errorMessage(err)}`)
      }
    }
  }
}

export function createMailEngine(store: MailStore, auth: AuthService, paths: AppPaths): MailEngine {
  const emitter = new TypedEmitter()
  const syncers = new Map<string, AccountSyncer>()
  let started = false

  const emit: MailEngineEvents = {
    newMail: (accountId, messages) => emitter.emit('newMail', accountId, messages),
    changed: (event) => emitter.emit('changed', event),
    status: (status) => emitter.emit('status', status),
    authError: (event) => emitter.emit('authError', event),
    foldersChanged: (accountId) => emitter.emit('foldersChanged', accountId)
  }

  const getSyncer = (accountId: string): AccountSyncer | undefined => syncers.get(accountId)

  const actions = createActionRunner({ store, emit, getSyncer })
  const sender = createSender({ store, auth, emit, getSyncer })
  const fetchService = createFetchService({ store, paths, emit, getSyncer })
  const draftService = createDraftService({ store, getSyncer })

  const syncDeps: SyncDeps = {
    store,
    auth,
    emit,
    onConnected: async (accountId: string) => {
      await actions.replay(accountId).catch((err) => engineLog.warn(`action replay failed: ${errorMessage(err)}`))
      await sender.flushOutbox(accountId).catch((err) => engineLog.warn(`outbox flush failed: ${errorMessage(err)}`))
    }
  }

  async function startAccount(accountId: string): Promise<void> {
    await stopAccount(accountId)
    const account = store.getAccount(accountId)
    if (!account) throw new Error('Account not found')
    const syncer = new AccountSyncer(account, syncDeps)
    syncers.set(accountId, syncer)
    if (!account.enabled) {
      emit.status({ accountId, state: 'disabled' })
      return
    }
    await syncer.start()
  }

  async function stopAccount(accountId: string): Promise<void> {
    const existing = syncers.get(accountId)
    if (!existing) return
    syncers.delete(accountId)
    await existing.stop().catch((err) => engineLog.warn(`stopping ${accountId} failed: ${errorMessage(err)}`))
  }

  async function requireSyncer(accountId: string): Promise<AccountSyncer> {
    const existing = syncers.get(accountId)
    if (existing) return existing
    await startAccount(accountId)
    const created = syncers.get(accountId)
    if (!created) throw new Error('Account is not available')
    return created
  }

  const engine: MailEngine = {
    on: (event, handler) => emitter.on(event, handler),

    async start(): Promise<void> {
      if (started) return
      started = true
      const accounts = store.listAccounts()
      await Promise.allSettled(
        accounts.map(async (account) => {
          try {
            await startAccount(account.id)
          } catch (err) {
            engineLog.warn(`could not start ${account.email}: ${errorMessage(err)}`)
            emit.status({ accountId: account.id, state: 'error', error: errorMessage(err) })
          }
        })
      )
    },

    async stop(): Promise<void> {
      started = false
      const ids = Array.from(syncers.keys())
      await Promise.allSettled(ids.map((id) => stopAccount(id)))
    },

    startAccount,
    stopAccount,

    async syncNow(accountId?: string): Promise<void> {
      if (accountId) {
        const syncer = await requireSyncer(accountId)
        await syncer.syncNow()
        return
      }
      await Promise.allSettled(Array.from(syncers.values()).map((syncer) => syncer.syncNow()))
    },

    getStatus(): SyncStatus[] {
      return store.listAccounts().map((account) => {
        const syncer = syncers.get(account.id)
        if (syncer) return syncer.getStatus()
        return {
          accountId: account.id,
          state: account.enabled ? 'idle' : 'disabled',
          lastSyncAt: account.lastSyncAt,
          error: account.lastError
        }
      })
    },

    async ensureBody(messageId: string): Promise<MessageFull> {
      return fetchService.ensureBody(messageId)
    },

    async downloadAttachment(attachmentId: string): Promise<AttachmentMeta> {
      return fetchService.downloadAttachment(attachmentId)
    },

    async fetchRaw(messageId: string): Promise<string> {
      return fetchService.fetchRaw(messageId)
    },

    async applyAction(request: MessageActionRequest): Promise<void> {
      await actions.applyAction(request)
    },

    async send(payload: ComposePayload): Promise<void> {
      await sender.send(payload)
    },

    async saveDraftRemote(draft: Draft): Promise<Draft> {
      return draftService.saveDraftRemote(draft)
    },

    async testConnection(input: AccountInput): Promise<ConnectionTestResult> {
      return testConnection(input, auth)
    },

    async createFolder(accountId: string, name: string, parentPath?: string): Promise<Folder> {
      const clean = name.trim()
      if (!clean) throw new Error('Folder name is required')
      const syncer = await requireSyncer(accountId)
      const existingFolders = store.listFolders(accountId)
      const delimiter = existingFolders.find((f) => f.delimiter)?.delimiter || '/'
      const inboxPrefixed = detectInboxPrefixed(
        existingFolders.map((f) => f.path),
        delimiter
      )
      const path = buildFolderPath(clean, { parentPath, delimiter, inboxPrefixed })

      const created = (await syncer.worker.withClient((client) => client.mailboxCreate(path))) as unknown as { path?: string } | undefined
      const finalPath = created?.path ?? path
      try {
        await syncer.worker.withClient((client) => client.mailboxSubscribe(finalPath))
      } catch (err) {
        engineLog.warn(`could not subscribe to ${finalPath}: ${errorMessage(err)}`)
      }

      const folders = await syncer.refreshFolders()
      emit.foldersChanged(accountId)
      const folder = folders.find((f) => f.path === finalPath) ?? folders.find((f) => f.path === path)
      if (!folder) throw new Error(`The folder "${clean}" was created but did not appear in the folder list.`)
      return folder
    }
  }

  return engine
}

export default createMailEngine
