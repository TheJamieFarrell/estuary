/**
 * Message actions: apply locally at once, queue, then replay to the server.
 */
import type { ImapFlow } from 'imapflow'
import log from 'electron-log/main'
import type { Folder, FolderKind, MessageAction, MessageActionRequest, MessageFlags, MessageSummary } from '@shared/types'
import type { MailEngineEvents, MailStore, PendingAction } from '../contracts'
import { errorMessage } from './connection'
import { archiveTargetKind } from './providers'
import type { AccountSyncer } from './sync'

const actionLog = log.scope('imap')

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 30 * 60_000
const MAX_ATTEMPTS = 12

export interface ActionDeps {
  store: MailStore
  emit: MailEngineEvents
  getSyncer: (accountId: string) => AccountSyncer | undefined
}

type ActionTarget = PendingAction['targets'][number]

const FLAG_ACTIONS: Partial<Record<MessageAction, { flag: keyof MessageFlags; value: boolean; imap: string }>> = {
  markRead: { flag: 'seen', value: true, imap: '\\Seen' },
  markUnread: { flag: 'seen', value: false, imap: '\\Seen' },
  star: { flag: 'flagged', value: true, imap: '\\Flagged' },
  unstar: { flag: 'flagged', value: false, imap: '\\Flagged' }
}

export interface ActionRunner {
  applyAction(request: MessageActionRequest): Promise<void>
  replay(accountId: string): Promise<void>
}

export function createActionRunner(deps: ActionDeps): ActionRunner {
  const nextAttemptAt = new Map<string, number>()
  const replaying = new Set<string>()

  function targetKindFor(action: MessageAction, syncer: AccountSyncer | undefined): FolderKind | undefined {
    switch (action) {
      case 'archive':
        return syncer ? archiveTargetKind(syncer.quirks) : 'archive'
      case 'trash':
        return 'trash'
      case 'spam':
        return 'spam'
      case 'notSpam':
        return 'inbox'
      default:
        return undefined
    }
  }

  function localFlagUpdate(targets: ActionTarget[], flag: keyof MessageFlags, value: boolean): void {
    deps.store.updateFlagsBulk(targets.map((t) => ({ folderId: t.folderId, uid: t.uid, flags: { [flag]: value } as Partial<MessageFlags> })))
  }

  async function applyAction(request: MessageActionRequest): Promise<void> {
    const summaries: MessageSummary[] = []
    for (const id of request.messageIds) {
      const summary = deps.store.getMessageSummary(id)
      if (summary) summaries.push(summary)
    }
    if (!summaries.length) return

    const byAccount = new Map<string, MessageSummary[]>()
    for (const summary of summaries) {
      const list = byAccount.get(summary.accountId) ?? []
      list.push(summary)
      byAccount.set(summary.accountId, list)
    }

    for (const [accountId, messages] of byAccount) {
      const syncer = deps.getSyncer(accountId)
      if (request.action === 'deletePermanently') {
        // Only really delete inside Trash/Spam; elsewhere this means "move to Trash".
        const hard: MessageSummary[] = []
        const soft: MessageSummary[] = []
        for (const message of messages) {
          const kind = deps.store.getFolder(message.folderId)?.kind
          if (kind === 'trash' || kind === 'spam') hard.push(message)
          else soft.push(message)
        }
        if (hard.length) await enqueue(accountId, { action: 'deletePermanently', messageIds: hard.map((m) => m.id) }, hard, syncer)
        if (soft.length) await enqueue(accountId, { action: 'trash', messageIds: soft.map((m) => m.id) }, soft, syncer)
        continue
      }
      await enqueue(accountId, { ...request, messageIds: messages.map((m) => m.id) }, messages, syncer)
    }
  }

  async function enqueue(
    accountId: string,
    request: MessageActionRequest,
    messages: MessageSummary[],
    syncer: AccountSyncer | undefined
  ): Promise<void> {
    const targets: ActionTarget[] = messages.map((m) => ({ messageId: m.id, folderId: m.folderId, uid: m.uid }))

    // 1. local effect
    const flagSpec = FLAG_ACTIONS[request.action]
    if (flagSpec) {
      localFlagUpdate(targets, flagSpec.flag, flagSpec.value)
    } else if (request.action === 'deletePermanently') {
      for (const target of targets) deps.store.deleteByUids(target.folderId, [target.uid])
    } else {
      const targetFolder = await resolveTargetFolder(accountId, request, syncer)
      if (targetFolder) {
        for (const target of targets) {
          if (target.folderId === targetFolder.id) continue
          deps.store.moveMessage(target.messageId, targetFolder.id)
        }
      }
    }

    // 2. queue for the server
    let pending: PendingAction | undefined
    try {
      pending = deps.store.enqueueAction({ accountId, request, targets })
    } catch (err) {
      actionLog.warn(`could not queue action ${request.action}: ${errorMessage(err)}`)
    }

    try {
      deps.emit.changed({
        accountId,
        reason: request.action === 'deletePermanently' ? 'delete' : 'action'
      })
    } catch {
      /* ignore */
    }

    if (pending) void replay(accountId).catch((err) => actionLog.warn(`replay failed: ${errorMessage(err)}`))
  }

  async function resolveTargetFolder(
    accountId: string,
    request: MessageActionRequest,
    syncer: AccountSyncer | undefined
  ): Promise<Folder | undefined> {
    if (request.action === 'move') {
      const target = request.targetFolderId ? deps.store.getFolder(request.targetFolderId) : undefined
      // Cross account moves are not a thing over IMAP.
      return target && target.accountId === accountId ? target : undefined
    }
    const kind = targetKindFor(request.action, syncer)
    if (!kind) return undefined
    const existing = deps.store.getFolderByKind(accountId, kind)
    if (existing) return existing
    if (kind === 'archive' && syncer) return await syncer.ensureFolderKind('archive')
    return undefined
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  async function replay(accountId: string): Promise<void> {
    if (replaying.has(accountId)) return
    const syncer = deps.getSyncer(accountId)
    if (!syncer) return
    replaying.add(accountId)
    let changed = false
    try {
      const pending = deps.store.listPendingActions(accountId)
      for (const action of pending) {
        const due = nextAttemptAt.get(action.id) ?? 0
        if (due > Date.now()) continue
        if (action.attempts >= MAX_ATTEMPTS) continue
        try {
          await runPendingAction(syncer, action)
          deps.store.completeAction(action.id)
          nextAttemptAt.delete(action.id)
          changed = true
        } catch (err) {
          const message = errorMessage(err)
          actionLog.warn(`action ${action.request.action} failed: ${message}`)
          try {
            deps.store.failAction(action.id, message)
          } catch {
            /* ignore */
          }
          const attempts = action.attempts + 1
          nextAttemptAt.set(action.id, Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 8)))
        }
      }
    } finally {
      replaying.delete(accountId)
    }
    if (changed) {
      try {
        deps.emit.changed({ accountId, reason: 'action' })
      } catch {
        /* ignore */
      }
    }
  }

  async function runPendingAction(syncer: AccountSyncer, action: PendingAction): Promise<void> {
    const request = action.request
    const groups = new Map<string, ActionTarget[]>()
    for (const target of action.targets) {
      const list = groups.get(target.folderId) ?? []
      list.push(target)
      groups.set(target.folderId, list)
    }

    const flagSpec = FLAG_ACTIONS[request.action]
    if (flagSpec) {
      for (const [folderId, targets] of groups) {
        const folder = deps.store.getFolder(folderId)
        if (!folder) continue
        const uids = targets.map((t) => t.uid)
        await syncer.worker.withMailbox(folder.path, async (client) => {
          if (flagSpec.value) await client.messageFlagsAdd(uids, [flagSpec.imap], { uid: true })
          else await client.messageFlagsRemove(uids, [flagSpec.imap], { uid: true })
        })
      }
      return
    }

    if (request.action === 'deletePermanently') {
      for (const [folderId, targets] of groups) {
        const folder = deps.store.getFolder(folderId)
        if (!folder) continue
        const uids = targets.map((t) => t.uid)
        await syncer.worker.withMailbox(folder.path, async (client) => {
          await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true })
          await client.messageDelete(uids, { uid: true })
        })
      }
      return
    }

    const targetFolder = await resolveTargetFolder(syncer.accountId, request, syncer)
    if (!targetFolder) throw new Error(`No destination folder for "${request.action}"`)

    for (const [folderId, targets] of groups) {
      if (folderId === targetFolder.id) continue
      const folder = deps.store.getFolder(folderId)
      if (!folder) continue
      const uids = targets.map((t) => t.uid)
      const uidMap = await moveUids(syncer, folder, uids, targetFolder.path)
      for (const target of targets) {
        const newUid = uidMap?.get(target.uid)
        try {
          deps.store.moveMessage(target.messageId, targetFolder.id, newUid)
        } catch (err) {
          actionLog.warn(`local move bookkeeping failed: ${errorMessage(err)}`)
        }
      }
    }
  }

  /** MOVE when the server has it, otherwise COPY + \Deleted + EXPUNGE. */
  async function moveUids(syncer: AccountSyncer, source: Folder, uids: number[], destination: string): Promise<Map<number, number> | undefined> {
    return syncer.worker.withMailbox(source.path, async (client: ImapFlow) => {
      const supportsMove = syncer.worker.supports('MOVE')
      if (supportsMove) {
        const result = (await client.messageMove(uids, destination, { uid: true })) as unknown as { uidMap?: Map<number, number> }
        return result?.uidMap
      }
      const copied = (await client.messageCopy(uids, destination, { uid: true })) as unknown as { uidMap?: Map<number, number> }
      await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true })
      await client.messageDelete(uids, { uid: true })
      return copied?.uidMap
    })
  }

  return { applyAction, replay }
}
