/**
 * On demand fetching: message bodies, raw sources and attachment downloads.
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { ImapFlow } from 'imapflow'
import log from 'electron-log/main'
import type { AttachmentMeta, Folder, MessageFull, MessageSummary } from '@shared/types'
import type { AppPaths, MailEngineEvents, MailStore } from '../contracts'
import { parseMessageSource, safeFilename, type ImapMessageLike } from './parse'
import type { AccountSyncer } from './sync'

const fetchLog = log.scope('imap')

export interface FetchDeps {
  store: MailStore
  paths: AppPaths
  emit: MailEngineEvents
  getSyncer: (accountId: string) => AccountSyncer | undefined
}

export interface FetchService {
  ensureBody(messageId: string): Promise<MessageFull>
  fetchRaw(messageId: string): Promise<string>
  downloadAttachment(attachmentId: string): Promise<AttachmentMeta>
}

export function createFetchService(deps: FetchDeps): FetchService {
  function locate(messageId: string): { summary: MessageSummary; folder: Folder; syncer: AccountSyncer } {
    const summary = deps.store.getMessageSummary(messageId)
    if (!summary) throw new Error('Message not found')
    const folder = deps.store.getFolder(summary.folderId)
    if (!folder) throw new Error('Folder not found for this message')
    const syncer = deps.getSyncer(summary.accountId)
    if (!syncer) throw new Error('This account is not connected. Enable it in Settings and try again.')
    return { summary, folder, syncer }
  }

  async function fetchSource(messageId: string): Promise<{ source: Buffer; structure?: ImapMessageLike['bodyStructure'] }> {
    const { summary, folder, syncer } = locate(messageId)
    return syncer.worker.withMailbox(folder.path, async (client: ImapFlow) => {
      const query = { uid: true, source: true, bodyStructure: true } as unknown as Parameters<ImapFlow['fetchOne']>[1]
      const options = { uid: true } as unknown as Parameters<ImapFlow['fetchOne']>[2]
      const message = (await client.fetchOne(String(summary.uid), query, options)) as unknown as ImapMessageLike | false
      if (!message || !message.source) throw new Error('The server did not return this message (it may have been deleted).')
      const source = Buffer.isBuffer(message.source) ? message.source : Buffer.from(String(message.source))
      return { source, structure: message.bodyStructure }
    })
  }

  async function ensureBody(messageId: string): Promise<MessageFull> {
    const existing = deps.store.getMessage(messageId)
    if (!existing) throw new Error('Message not found')
    if (existing.bodyFetched) return existing

    const { source, structure } = await fetchSource(messageId)
    const body = await parseMessageSource(source, structure)
    deps.store.setMessageBody(messageId, {
      html: body.html,
      text: body.text,
      headers: body.headers,
      attachments: body.attachments
    })
    try {
      deps.emit.changed({ accountId: existing.accountId, folderId: existing.folderId, reason: 'sync' })
    } catch {
      /* ignore */
    }
    return deps.store.getMessage(messageId) ?? existing
  }

  async function fetchRaw(messageId: string): Promise<string> {
    const { source } = await fetchSource(messageId)
    return source.toString('utf8')
  }

  async function downloadAttachment(attachmentId: string): Promise<AttachmentMeta> {
    const meta = deps.store.getAttachment(attachmentId)
    if (!meta) throw new Error('Attachment not found')
    if (meta.localPath) return meta

    const { summary, folder, syncer } = locate(meta.messageId)
    const dir = join(deps.paths.attachmentsDir, summary.accountId, summary.id)
    await mkdir(dir, { recursive: true })
    const target = join(dir, safeFilename(meta.filename, `attachment-${meta.partId}`))

    await syncer.worker.withMailbox(folder.path, async (client: ImapFlow) => {
      const download = (await client.download(String(summary.uid), meta.partId || '1', { uid: true })) as unknown as {
        content?: Readable
      }
      if (!download?.content) throw new Error('The server did not return this attachment.')
      await pipeline(download.content, createWriteStream(target))
    })

    deps.store.setAttachmentLocalPath(attachmentId, target)
    fetchLog.info(`saved attachment ${meta.filename} -> ${target}`)
    return deps.store.getAttachment(attachmentId) ?? { ...meta, localPath: target }
  }

  return { ensureBody, fetchRaw, downloadAttachment }
}
