/**
 * Remote drafts: APPEND the MIME to the Drafts mailbox with \Draft and drop the
 * previously uploaded copy.
 */
import log from 'electron-log/main'
import type { Draft } from '@shared/types'
import type { MailStore } from '../contracts'
import { errorMessage } from './connection'
import { buildMailOptions, composeRaw } from './smtp'
import type { AccountSyncer } from './sync'

const draftLog = log.scope('imap')

export interface DraftDeps {
  store: MailStore
  getSyncer: (accountId: string) => AccountSyncer | undefined
}

export interface DraftService {
  saveDraftRemote(draft: Draft): Promise<Draft>
}

export function createDraftService(deps: DraftDeps): DraftService {
  async function saveDraftRemote(draft: Draft): Promise<Draft> {
    const account = deps.store.getAccount(draft.accountId)
    if (!account) throw new Error('Account not found')
    const syncer = deps.getSyncer(draft.accountId)
    const folder = deps.store.getFolderByKind(draft.accountId, 'drafts')
    if (!syncer || !folder) {
      // Local only draft: still perfectly usable, it just is not on the server yet.
      draftLog.warn(`no Drafts folder/connection for ${account.email}; keeping the draft local`)
      return draft
    }

    const original = draft.payload.inReplyToMessageId ? deps.store.getMessage(draft.payload.inReplyToMessageId) : undefined
    const raw = await composeRaw(buildMailOptions(account, draft.payload, original))
    const previousUid = draft.remoteUid

    const appended = (await syncer.worker.withClient((client) => client.append(folder.path, raw, ['\\Draft', '\\Seen'], new Date()))) as unknown as
      | { uid?: number }
      | undefined
    const remoteUid = typeof appended?.uid === 'number' ? appended.uid : undefined

    if (previousUid) {
      try {
        await syncer.worker.withMailbox(folder.path, async (client) => {
          await client.messageFlagsAdd([previousUid], ['\\Deleted'], { uid: true })
          await client.messageDelete([previousUid], { uid: true })
        })
      } catch (err) {
        draftLog.warn(`could not remove the previous draft copy: ${errorMessage(err)}`)
      }
    }

    const saved = deps.store.saveDraft({ ...draft.payload, draftId: draft.id }, remoteUid)
    return saved ?? { ...draft, remoteUid }
  }

  return { saveDraftRemote }
}
