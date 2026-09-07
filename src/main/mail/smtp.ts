/**
 * Outgoing mail: MIME building, SMTP transports, the outbox and the post-send
 * bookkeeping (APPEND to Sent, \Answered / $Forwarded on the original, draft cleanup).
 */
import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import log from 'electron-log/main'
import type { Account, ComposeAttachment, ComposePayload, EmailAddress, MessageFull } from '@shared/types'
import type { AuthService, MailEngineEvents, MailStore, OutboxItem } from '../contracts'
import { errorMessage, resolveAuthForAccount, type ResolvedAuth } from './connection'
import { htmlToText } from './parse'
import type { AccountSyncer } from './sync'

const smtpLog = log.scope('smtp')

const SEND_TIMEOUT_MS = 60_000
const OUTBOX_RETRY_BASE_MS = 30_000
const OUTBOX_MAX_ATTEMPTS = 10

export interface SmtpDeps {
  store: MailStore
  auth: AuthService
  emit: MailEngineEvents
  getSyncer: (accountId: string) => AccountSyncer | undefined
}

export interface Sender {
  send(payload: ComposePayload): Promise<void>
  flushOutbox(accountId?: string): Promise<void>
  buildRaw(account: Account, payload: ComposePayload): Promise<Buffer>
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

function toAddress(address: EmailAddress): Mail.Address {
  return address.name ? { name: address.name, address: address.address } : { name: '', address: address.address }
}

function mapAttachment(attachment: ComposeAttachment): Mail.Attachment {
  const base: Mail.Attachment = {
    filename: attachment.filename,
    contentType: attachment.contentType || 'application/octet-stream'
  }
  if (attachment.contentId) {
    base.cid = attachment.contentId
    base.contentDisposition = 'inline'
  }
  if (attachment.path) return { ...base, path: attachment.path }
  return { ...base, content: Buffer.from(attachment.contentBase64 ?? '', 'base64') }
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1) : 'localhost'
}

/** Build the nodemailer options for a compose payload (used for sending and for drafts). */
export function buildMailOptions(account: Account, payload: ComposePayload, original?: MessageFull): Mail.Options {
  const html = payload.html && payload.html.trim().length ? payload.html : undefined
  const text = payload.text && payload.text.trim().length ? payload.text : html ? htmlToText(html) : ''
  const isReply = payload.mode === 'reply' || payload.mode === 'replyAll'

  const references: string[] = []
  if (original) {
    for (const reference of original.references ?? []) references.push(reference)
    if (original.messageIdHeader) references.push(original.messageIdHeader)
  }

  const options: Mail.Options = {
    from: { name: account.name || '', address: account.email },
    to: payload.to.map(toAddress),
    cc: payload.cc.map(toAddress),
    bcc: payload.bcc.map(toAddress),
    subject: payload.subject ?? '',
    text,
    messageId: `<${randomUUID()}@${domainOf(account.email)}>`,
    headers: { 'X-Mailer': 'Estuary' },
    attachments: payload.attachments.map(mapAttachment)
  }
  if (html) options.html = html
  if (isReply && original?.messageIdHeader) options.inReplyTo = `<${original.messageIdHeader}>`
  if (references.length) options.references = references.map((r) => (r.startsWith('<') ? r : `<${r}>`))
  return options
}

export async function composeRaw(options: Mail.Options): Promise<Buffer> {
  const composer = new MailComposer(options)
  return await composer.compile().build()
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildTransportOptions(account: Pick<Account, 'smtp'>, credentials: ResolvedAuth): SMTPTransport.Options {
  const secure = account.smtp.secure
  const options: SMTPTransport.Options = {
    host: account.smtp.host,
    port: account.smtp.port,
    secure,
    // Plain 587 must be upgraded with STARTTLS.
    requireTLS: !secure,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: SEND_TIMEOUT_MS,
    tls: { minVersion: 'TLSv1.2' },
    auth: credentials.accessToken
      ? { type: 'OAuth2', user: credentials.user, accessToken: credentials.accessToken }
      : { user: credentials.user, pass: credentials.pass ?? '' }
  }
  return options
}

export function createTransport(account: Pick<Account, 'smtp'>, credentials: ResolvedAuth): Transporter<SMTPTransport.SentMessageInfo> {
  return nodemailer.createTransport(buildTransportOptions(account, credentials))
}

/** Turn provider babble into something a human can act on. */
export function describeSmtpError(err: unknown): string {
  const message = errorMessage(err)
  if (/Application-specific password required/i.test(message)) {
    return 'Google rejected the password: this account needs an app password (or sign in with Google instead).'
  }
  if (/Username and Password not accepted|BadCredentials|535/i.test(message)) {
    return 'The mail server rejected the username or password.'
  }
  if (/basic authentication is disabled|AUTH .*(disabled|unsupported)|SmtpClientAuthentication/i.test(message)) {
    return 'This server no longer accepts password logins - connect the account with OAuth instead.'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'Could not find the SMTP server - check the host name.'
  if (/ECONNREFUSED/i.test(message)) return 'The SMTP server refused the connection - check the port.'
  if (/ETIMEDOUT|timed? ?out/i.test(message)) return 'The SMTP server did not answer in time.'
  if (/certificate|self.signed|SSL|TLS/i.test(message)) return `TLS problem talking to the SMTP server: ${message}`
  return message
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export function createSender(deps: SmtpDeps): Sender {
  const nextAttemptAt = new Map<string, number>()
  const flushing = new Set<string>()

  async function buildRaw(account: Account, payload: ComposePayload): Promise<Buffer> {
    const original = payload.inReplyToMessageId ? deps.store.getMessage(payload.inReplyToMessageId) : undefined
    return composeRaw(buildMailOptions(account, payload, original))
  }

  async function deliver(account: Account, payload: ComposePayload): Promise<void> {
    const credentials = await resolveAuthForAccount(account.id, deps.store, deps.auth)
    const raw = await buildRaw(account, payload)
    const recipients = [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.address).filter(Boolean)
    if (!recipients.length) throw new Error('This message has no recipients.')

    const transporter = createTransport(account, credentials)
    try {
      await transporter.sendMail({
        envelope: { from: account.email, to: recipients },
        raw
      })
    } finally {
      try {
        transporter.close()
      } catch {
        /* ignore */
      }
    }

    await afterSend(account, payload, raw)
  }

  /** Everything that must happen once the message is on its way. Never fatal. */
  async function afterSend(account: Account, payload: ComposePayload, raw: Buffer): Promise<void> {
    const syncer = deps.getSyncer(account.id)

    if (syncer && !syncer.quirks.smtpAutoSavesSent) {
      const sent = deps.store.getFolderByKind(account.id, 'sent')
      if (sent) {
        try {
          await syncer.worker.withClient((client) => client.append(sent.path, raw, ['\\Seen'], new Date()))
        } catch (err) {
          smtpLog.warn(`could not append to ${sent.path}: ${errorMessage(err)}`)
        }
      } else {
        smtpLog.warn(`no Sent folder for ${account.email}; the copy was not saved`)
      }
    }

    if (payload.inReplyToMessageId && (payload.mode === 'reply' || payload.mode === 'replyAll' || payload.mode === 'forward')) {
      const original = deps.store.getMessageSummary(payload.inReplyToMessageId)
      const folder = original ? deps.store.getFolder(original.folderId) : undefined
      const flag = payload.mode === 'forward' ? '$Forwarded' : '\\Answered'
      if (original && folder && syncer) {
        try {
          await syncer.worker.withMailbox(folder.path, (client) => client.messageFlagsAdd([original.uid], [flag], { uid: true }))
        } catch (err) {
          smtpLog.warn(`could not flag the original message: ${errorMessage(err)}`)
        }
      }
      if (original) {
        try {
          deps.store.updateFlags(original.folderId, original.uid, payload.mode === 'forward' ? { forwarded: true } : { answered: true })
        } catch {
          /* ignore */
        }
      }
    }

    if (payload.draftId) {
      const draft = deps.store.getDraft(payload.draftId)
      const drafts = deps.store.getFolderByKind(account.id, 'drafts')
      if (draft?.remoteUid && drafts && syncer) {
        try {
          await syncer.worker.withMailbox(drafts.path, async (client) => {
            await client.messageFlagsAdd([draft.remoteUid as number], ['\\Deleted'], { uid: true })
            await client.messageDelete([draft.remoteUid as number], { uid: true })
          })
        } catch (err) {
          smtpLog.warn(`could not remove the remote draft: ${errorMessage(err)}`)
        }
      }
      try {
        deps.store.deleteDraft(payload.draftId)
      } catch {
        /* ignore */
      }
    }

    try {
      deps.emit.changed({ accountId: account.id, reason: 'send' })
    } catch {
      /* ignore */
    }
  }

  async function send(payload: ComposePayload): Promise<void> {
    const account = deps.store.getAccount(payload.accountId)
    if (!account) throw new Error('Account not found')

    const item = deps.store.enqueueOutbox(payload)
    try {
      deps.store.updateOutbox(item.id, { status: 'sending' })
    } catch {
      /* ignore */
    }
    try {
      await deliver(account, payload)
      deps.store.deleteOutbox(item.id)
      smtpLog.info(`sent message for ${account.email}`)
    } catch (err) {
      const message = describeSmtpError(err)
      smtpLog.warn(`send failed for ${account.email}: ${message}`)
      try {
        deps.store.updateOutbox(item.id, { status: 'failed', lastError: message, attempts: (item.attempts ?? 0) + 1 })
      } catch {
        /* ignore */
      }
      nextAttemptAt.set(item.id, Date.now() + OUTBOX_RETRY_BASE_MS)
      throw new Error(`${message} The message stays in the outbox and will be retried.`)
    }
  }

  /** Retry queued/failed outbox items (called on reconnect and after each sync pass). */
  async function flushOutbox(accountId?: string): Promise<void> {
    const items: OutboxItem[] = deps.store.listOutbox(accountId)
    for (const item of items) {
      if (item.status === 'sending') continue
      if (item.attempts >= OUTBOX_MAX_ATTEMPTS) continue
      const due = nextAttemptAt.get(item.id) ?? 0
      if (due > Date.now()) continue
      if (flushing.has(item.id)) continue
      const account = deps.store.getAccount(item.accountId)
      if (!account || !account.enabled) continue
      flushing.add(item.id)
      try {
        deps.store.updateOutbox(item.id, { status: 'sending' })
        await deliver(account, item.payload)
        deps.store.deleteOutbox(item.id)
        nextAttemptAt.delete(item.id)
      } catch (err) {
        const message = describeSmtpError(err)
        const attempts = item.attempts + 1
        try {
          deps.store.updateOutbox(item.id, { status: 'failed', lastError: message, attempts })
        } catch {
          /* ignore */
        }
        nextAttemptAt.set(item.id, Date.now() + Math.min(60 * 60_000, OUTBOX_RETRY_BASE_MS * 2 ** Math.min(attempts, 6)))
      } finally {
        flushing.delete(item.id)
      }
    }
  }

  return { send, flushOutbox, buildRaw }
}
