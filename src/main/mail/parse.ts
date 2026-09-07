/**
 * Pure parsing helpers for the mail engine.
 *
 * Nothing here touches the network, the store or electron, so it is unit testable.
 * imapflow objects are consumed through the structural `Imap*` interfaces below
 * (they match imapflow's FetchMessageObject but keep this module dependency free).
 */
import { simpleParser } from 'mailparser'
import iconv from 'iconv-lite'
import type { AttachmentMeta, EmailAddress, MessageFlags } from '@shared/types'
import type { MessageBody, MessageUpsert } from '../contracts'

// ---------------------------------------------------------------------------
// Structural views of imapflow data
// ---------------------------------------------------------------------------

export interface ImapAddress {
  name?: string
  address?: string
}

export interface ImapEnvelope {
  date?: Date | string
  subject?: string
  messageId?: string
  inReplyTo?: string
  from?: ImapAddress[]
  sender?: ImapAddress[]
  replyTo?: ImapAddress[]
  to?: ImapAddress[]
  cc?: ImapAddress[]
  bcc?: ImapAddress[]
}

export interface ImapBodyStructure {
  /** IMAP part id, e.g. '2' or '1.2'. Undefined for the root of a single part message. */
  part?: string
  /** Lowercase mime type, e.g. 'text/plain' or 'multipart/mixed' */
  type?: string
  parameters?: Record<string, string>
  /** Content-Id, with angle brackets */
  id?: string
  encoding?: string
  size?: number
  disposition?: string | false | null
  dispositionParameters?: Record<string, string>
  childNodes?: ImapBodyStructure[]
}

export interface ImapMessageLike {
  uid: number
  seq?: number
  flags?: Set<string> | string[]
  envelope?: ImapEnvelope
  bodyStructure?: ImapBodyStructure
  internalDate?: Date | string
  size?: number
  /** Gmail labels (X-GM-LABELS) */
  labels?: Set<string> | string[]
  /** Gmail thread id (X-GM-THRID) */
  threadId?: string
  /** OBJECTID / X-GM-MSGID */
  emailId?: string
  source?: Buffer | string
  /** Raw header block when the fetch asked for specific headers */
  headers?: Buffer | string
  /** Requested body parts, e.g. a partial BODY[TEXT] used for list snippets */
  bodyParts?: Map<string, Buffer>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function toArray(value: Set<string> | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value.slice() : Array.from(value)
}

export function stripAngles(value?: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().replace(/^<+/, '').replace(/>+$/, '').trim()
  return trimmed.length ? trimmed : undefined
}

export function parseAddresses(list?: ImapAddress[]): EmailAddress[] {
  if (!list || !Array.isArray(list)) return []
  const out: EmailAddress[] = []
  for (const entry of list) {
    if (!entry) continue
    const address = (entry.address ?? '').trim()
    if (!address) continue
    const name = (entry.name ?? '').trim()
    out.push(name ? { name, address } : { address })
  }
  return out
}

const SYSTEM_FLAGS: Record<string, keyof MessageFlags> = {
  '\\seen': 'seen',
  '\\flagged': 'flagged',
  '\\answered': 'answered',
  '\\draft': 'draft',
  '$forwarded': 'forwarded',
  '\\forwarded': 'forwarded',
  forwarded: 'forwarded'
}

export function parseFlags(flags: Set<string> | string[] | undefined): MessageFlags {
  const result: MessageFlags = { seen: false, flagged: false, answered: false, draft: false, forwarded: false }
  for (const raw of toArray(flags)) {
    const key = SYSTEM_FLAGS[String(raw).toLowerCase()]
    if (key) result[key] = true
  }
  return result
}

export function flagNamesFor(flag: keyof MessageFlags): string {
  switch (flag) {
    case 'seen':
      return '\\Seen'
    case 'flagged':
      return '\\Flagged'
    case 'answered':
      return '\\Answered'
    case 'draft':
      return '\\Draft'
    case 'forwarded':
      return '$Forwarded'
  }
}

export function toEpoch(value: Date | string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  return Number.isFinite(time) ? time : undefined
}

// ---------------------------------------------------------------------------
// Body structure
// ---------------------------------------------------------------------------

export interface StructurePart {
  partId: string
  contentType: string
  filename?: string
  contentId?: string
  size: number
  isInline: boolean
  isAttachment: boolean
}

function partFilename(node: ImapBodyStructure): string | undefined {
  const fromDisposition = node.dispositionParameters?.filename ?? node.dispositionParameters?.['filename*']
  const fromParams = node.parameters?.name ?? node.parameters?.['name*']
  const value = (fromDisposition ?? fromParams ?? '').toString().trim()
  return value.length ? value : undefined
}

/** Flatten a BODYSTRUCTURE into leaf parts with attachment/inline classification. */
export function flattenStructure(root: ImapBodyStructure | undefined): StructurePart[] {
  const out: StructurePart[] = []
  const walk = (node: ImapBodyStructure | undefined, fallbackPart: string): void => {
    if (!node) return
    const type = (node.type ?? '').toLowerCase()
    if (type.startsWith('multipart')) {
      const children = node.childNodes ?? []
      children.forEach((child, index) => walk(child, node.part ? `${node.part}.${index + 1}` : `${index + 1}`))
      return
    }
    const partId = node.part && node.part.length ? node.part : fallbackPart
    const disposition = typeof node.disposition === 'string' ? node.disposition.toLowerCase() : ''
    const filename = partFilename(node)
    const contentId = stripAngles(node.id)
    const isInline = disposition === 'inline' || (!!contentId && disposition !== 'attachment')
    let isAttachment: boolean
    if (disposition === 'attachment') {
      isAttachment = true
    } else if ((type === 'text/plain' || type === 'text/html') && !filename) {
      isAttachment = false
    } else if (isInline && (type.startsWith('image/') || !filename)) {
      // Inline images (cid: referenced signatures, embedded screenshots) are part of the body.
      isAttachment = false
    } else {
      isAttachment = !!filename || type === 'message/rfc822'
    }
    out.push({
      partId,
      contentType: type || 'application/octet-stream',
      filename,
      contentId,
      size: typeof node.size === 'number' ? node.size : 0,
      isInline,
      isAttachment
    })
  }
  walk(root, '1')
  return out
}

/** True when the message has at least one real (non-inline) attachment. */
export function hasAttachments(structure: ImapBodyStructure | undefined): boolean {
  return flattenStructure(structure).some((part) => part.isAttachment)
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  zwnj: '',
  zwj: '',
  shy: '',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' '
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const key = entity.toLowerCase()
    if (ENTITIES[key] !== undefined) return ENTITIES[key]
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return match
  })
}

/** Very small HTML -> text conversion; good enough for snippets and text fallbacks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
      // Hidden "preheader" blocks newsletters stuff with padding characters
      .replace(/<([a-z][a-z0-9]*)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim()
}

export const SNIPPET_LENGTH = 160

/** First ~160 whitespace-collapsed characters of the message body. */
export function makeSnippet(input: { text?: string; html?: string }, length = SNIPPET_LENGTH): string {
  const source = input.text && input.text.trim().length ? input.text : input.html ? htmlToText(input.html) : ''
  const collapsed = decodeEntities(source)
    .replace(/^\s*>.*$/gm, '') // drop quoted lines
    .replace(/[[(<]?\s*https?:\/\/[^\s\])>]+\s*[\])>]?/g, ' ') // bare/bracketed links say nothing in a preview
    .replace(/‌|​|­|﻿/g, '') // zero-width "preheader" padding used by newsletters
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= length) return collapsed
  const cut = collapsed.slice(0, length)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > length * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Envelope -> MessageUpsert
// ---------------------------------------------------------------------------

/** Parse a raw header block (as returned by FETCH BODY.PEEK[HEADER.FIELDS (...)]). */
export function parseHeaderBlock(raw: Buffer | string | undefined): Record<string, string> {
  if (!raw) return {}
  const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).replace(/\r\n/g, '\n')
  const out: Record<string, string> = {}
  let currentKey = ''
  for (const line of text.split('\n')) {
    if (!line.trim().length) continue
    if (/^\s/.test(line) && currentKey) {
      out[currentKey] = `${out[currentKey]} ${line.trim()}`
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    currentKey = line.slice(0, idx).trim().toLowerCase()
    out[currentKey] = line.slice(idx + 1).trim()
  }
  return out
}

export function parseReferences(value: string | undefined): string[] {
  if (!value) return []
  const matches = value.match(/<[^>]+>/g)
  if (matches) return matches.map((m) => m.slice(1, -1).trim()).filter(Boolean)
  return value
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

export interface UpsertContext {
  accountId: string
  folderId: string
}

/** Map one fetched message (envelope level) to the store's upsert row. */
export function toMessageUpsert(ctx: UpsertContext, msg: ImapMessageLike): MessageUpsert {
  const envelope = msg.envelope ?? {}
  const headers = parseHeaderBlock(msg.headers)
  const internalDate = toEpoch(msg.internalDate)
  const date = toEpoch(envelope.date) ?? internalDate ?? Date.now()
  const references = parseReferences(headers.references)
  const inReplyTo = stripAngles(envelope.inReplyTo ?? headers['in-reply-to'])
  const from = parseAddresses(envelope.from ?? envelope.sender)
  return {
    accountId: ctx.accountId,
    folderId: ctx.folderId,
    uid: msg.uid,
    messageIdHeader: stripAngles(envelope.messageId ?? headers['message-id']),
    inReplyTo,
    references,
    gmThrid: msg.threadId ? String(msg.threadId) : undefined,
    gmMsgid: msg.emailId ? String(msg.emailId) : undefined,
    subject: (envelope.subject ?? '').trim(),
    from,
    to: parseAddresses(envelope.to),
    cc: parseAddresses(envelope.cc),
    bcc: parseAddresses(envelope.bcc),
    replyTo: parseAddresses(envelope.replyTo),
    date,
    internalDate,
    flags: parseFlags(msg.flags),
    hasAttachments: hasAttachments(msg.bodyStructure),
    size: typeof msg.size === 'number' ? msg.size : 0,
    labels: toArray(msg.labels),
    snippet: snippetFromPartialText(msg.bodyParts?.get('text'), msg.bodyStructure) || undefined
  }
}

// ---------------------------------------------------------------------------
// Partial BODY[TEXT] -> snippet (cheap list previews without downloading bodies)
// ---------------------------------------------------------------------------

/** How many bytes of BODY[TEXT] the sync fetches per message purely for the list preview. */
export const SNIPPET_FETCH_BYTES = 4096

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i)
    if (ch === 0x3d /* = */ && i + 2 < joined.length && /^[0-9a-f]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(ch & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function decodeBase64Partial(text: string): Buffer {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '')
  // Complete data keeps its '=' padding; a truncated fetch is cut back to whole 4-char groups.
  const usable = clean.endsWith('=') ? clean : clean.slice(0, clean.length - (clean.length % 4))
  return Buffer.from(usable, 'base64')
}

function decodeCharset(buf: Buffer, charset: string | undefined): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '')
  try {
    if (/^(utf-?8|us-?ascii|ascii)$/.test(cs)) return buf.toString('utf8')
    if (iconv.encodingExists(cs)) return iconv.decode(buf, cs)
  } catch {
    /* fall through */
  }
  return buf.toString('utf8')
}

interface TextCandidate {
  content: string
  type: string
  encoding: string
  charset?: string
}

function headerParam(head: string, name: string, param: string): string | undefined {
  const line = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im').exec(head)?.[1]
  if (!line) return undefined
  const m = new RegExp(`${param}\\s*=\\s*"?([^";\\r\\n]+)"?`, 'i').exec(line)
  return m?.[1]?.trim()
}

function headerValue(head: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*([^;\\r\\n]+)`, 'im').exec(head)?.[1]?.trim().toLowerCase()
}

/** Walk a (possibly truncated) MIME body and return the first text/* part, plain preferred. */
function pickTextPart(body: string, boundary: string | undefined, depth = 0): TextCandidate | undefined {
  if (!boundary || depth > 4) return undefined
  const chunks = body.split(`--${boundary}`)
  let html: TextCandidate | undefined
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) break // closing boundary
    const sep = chunk.search(/\r?\n\r?\n/)
    if (sep < 0) continue
    const head = chunk.slice(0, sep)
    const content = chunk.slice(sep).replace(/^\r?\n\r?\n/, '')
    const type = headerValue(head, 'content-type') ?? 'text/plain'
    if (type.startsWith('multipart/')) {
      const found = pickTextPart(content, headerParam(head, 'content-type', 'boundary'), depth + 1)
      if (found?.type === 'text/plain') return found
      html = html ?? found
      continue
    }
    if (!type.startsWith('text/')) continue
    if (/attachment/i.test(headerValue(head, 'content-disposition') ?? '')) continue
    const candidate: TextCandidate = {
      content,
      type,
      encoding: headerValue(head, 'content-transfer-encoding') ?? '7bit',
      charset: headerParam(head, 'content-type', 'charset')
    }
    if (type === 'text/plain') return candidate
    html = html ?? candidate
  }
  return html
}

/**
 * Turn the first few KB of BODY[TEXT] into a list snippet. For single part messages the
 * BODYSTRUCTURE tells us type/encoding/charset; for multipart the part headers inside the
 * text do. Truncated quoted-printable / base64 tails are tolerated.
 */
export function snippetFromPartialText(raw: Buffer | string | undefined, structure?: ImapBodyStructure): string {
  if (!raw || raw.length === 0) return ''
  const latin = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw
  const rootType = (structure?.type ?? 'text/plain').toLowerCase()
  let candidate: TextCandidate | undefined
  if (rootType.startsWith('multipart/')) {
    const boundary = structure?.parameters?.boundary ?? /--([^\r\n]+)\r?\n/.exec(latin)?.[1]
    candidate = pickTextPart(latin, boundary)
  } else if (rootType.startsWith('text/')) {
    candidate = {
      content: latin,
      type: rootType,
      encoding: (structure?.encoding ?? '7bit').toLowerCase(),
      charset: structure?.parameters?.charset
    }
  }
  if (!candidate) return ''
  const enc = candidate.encoding.toLowerCase()
  const bytes =
    enc === 'quoted-printable'
      ? decodeQuotedPrintable(candidate.content)
      : enc === 'base64'
        ? decodeBase64Partial(candidate.content)
        : Buffer.from(candidate.content, 'latin1')
  const text = decodeCharset(bytes, candidate.charset)
  // A truncated fetch may end mid-tag; drop the dangling fragment before stripping tags.
  const cleaned =
    candidate.type === 'text/html' ? htmlToText(text.replace(/<!--(?:(?!-->)[\s\S])*$/, '').replace(/<[^>]*$/, '')) : text
  return makeSnippet({ text: cleaned })
}

// ---------------------------------------------------------------------------
// Raw source -> MessageBody
// ---------------------------------------------------------------------------

/** Headers kept alongside the body (the reader and the unsubscribe button need these). */
export const KEPT_HEADERS = [
  'message-id',
  'in-reply-to',
  'references',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'return-path',
  'delivered-to',
  'reply-to',
  'sender',
  'date',
  'subject',
  'from',
  'to',
  'cc',
  'x-mailer',
  'x-priority',
  'importance',
  'auto-submitted',
  'precedence',
  'content-type'
]

type ParsedAttachment = {
  filename?: string
  contentType?: string
  size?: number
  cid?: string
  contentDisposition?: string
  related?: boolean
}

function pickPartIds(structure: ImapBodyStructure | undefined, attachments: ParsedAttachment[]): (string | undefined)[] {
  const parts = flattenStructure(structure).filter((p) => p.isAttachment || p.isInline || !!p.filename)
  const used = new Set<string>()
  return attachments.map((attachment, index) => {
    const cid = stripAngles(attachment.cid)
    const byCid = cid ? parts.find((p) => p.contentId === cid && !used.has(p.partId)) : undefined
    if (byCid) {
      used.add(byCid.partId)
      return byCid.partId
    }
    const name = (attachment.filename ?? '').toLowerCase()
    const byName = name ? parts.find((p) => (p.filename ?? '').toLowerCase() === name && !used.has(p.partId)) : undefined
    if (byName) {
      used.add(byName.partId)
      return byName.partId
    }
    const byIndex = parts.filter((p) => !used.has(p.partId))[0] ?? parts[index]
    if (byIndex) {
      used.add(byIndex.partId)
      return byIndex.partId
    }
    return undefined
  })
}

/**
 * Parse an RFC822 source into the store's body shape.
 * Pass the BODYSTRUCTURE when available so attachment part ids are real IMAP part ids.
 */
export async function parseMessageSource(
  source: Buffer | string,
  structure?: ImapBodyStructure
): Promise<MessageBody & { snippet: string; references: string[]; inReplyTo?: string; hasAttachments: boolean }> {
  const parsed = await simpleParser(source, { skipTextLinks: true })

  const headers: Record<string, string> = {}
  const wanted = new Set(KEPT_HEADERS)
  for (const line of parsed.headerLines ?? []) {
    const key = line.key.toLowerCase()
    if (!wanted.has(key)) continue
    const idx = line.line.indexOf(':')
    const value = idx >= 0 ? line.line.slice(idx + 1).trim() : line.line.trim()
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }

  const rawAttachments = (parsed.attachments ?? []) as unknown as ParsedAttachment[]
  const partIds = pickPartIds(structure, rawAttachments)
  const attachments: MessageBody['attachments'] = rawAttachments.map((attachment, index) => {
    const contentId = stripAngles(attachment.cid)
    const disposition = (attachment.contentDisposition ?? '').toLowerCase()
    const isInline = disposition === 'inline' || attachment.related === true || (!!contentId && disposition !== 'attachment')
    return {
      filename: attachment.filename && attachment.filename.length ? attachment.filename : `part-${index + 1}`,
      contentType: (attachment.contentType ?? 'application/octet-stream').toLowerCase(),
      size: typeof attachment.size === 'number' ? attachment.size : 0,
      contentId,
      isInline,
      partId: partIds[index] ?? String(index + 1)
    } satisfies Omit<AttachmentMeta, 'id' | 'messageId' | 'localPath'>
  })

  const html = typeof parsed.html === 'string' && parsed.html.length ? parsed.html : undefined
  const text = typeof parsed.text === 'string' && parsed.text.length ? parsed.text : undefined

  return {
    html,
    text: text ?? (html ? htmlToText(html) : undefined),
    headers,
    attachments,
    snippet: makeSnippet({ text, html }),
    references: parseReferences(headers.references ?? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)),
    inReplyTo: stripAngles(parsed.inReplyTo ?? headers['in-reply-to']),
    hasAttachments: attachments.some((a) => !a.isInline)
  }
}

/** Windows-safe file name for the attachment cache. */
export function safeFilename(filename: string | undefined, fallback = 'attachment'): string {
  const base = Array.from(filename ?? '')
    .map((ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch))
    .join('')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const cleaned = base.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!cleaned.length) return fallback
  if (cleaned.length <= 120) return cleaned
  const dot = cleaned.lastIndexOf('.')
  if (dot > 0 && cleaned.length - dot <= 12) return `${cleaned.slice(0, 120 - (cleaned.length - dot))}${cleaned.slice(dot)}`
  return cleaned.slice(0, 120)
}
