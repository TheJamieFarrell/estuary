/**
 * Pure helpers for the compose window: address parsing, signature and quote handling,
 * size formatting and content-id generation. Kept free of React so they are easy to test.
 */
import type { ComposeAttachment, EmailAddress } from '@shared/types'

export const SIGNATURE_CLASS = 'estuary-signature'
export const QUOTE_CLASS = 'estuary-quote'

/** Reasonably strict address check - good enough for UI validation. */
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/

export function isValidAddress(address: string): boolean {
  return ADDRESS_RE.test(address.trim())
}

/**
 * Split a raw string into candidate address tokens. Commas and semicolons separate,
 * but not inside quotes or angle brackets, so `"Doe, Jane" <j@x.com>` stays intact.
 */
export function splitAddressList(raw: string): string[] {
  const out: string[] = []
  let buf = ''
  let inQuote = false
  let inAngle = false
  for (const ch of raw) {
    if (ch === '"') {
      inQuote = !inQuote
      buf += ch
      continue
    }
    if (!inQuote && ch === '<') inAngle = true
    if (!inQuote && ch === '>') inAngle = false
    if (!inQuote && !inAngle && (ch === ',' || ch === ';' || ch === '\n')) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** Parse a single token like `Jane Doe <jane@x.com>` or `jane@x.com`. */
export function parseAddress(token: string): EmailAddress {
  const t = token.trim()
  const angle = t.match(/^(.*)<([^>]*)>\s*$/)
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim()
    return name ? { name, address: angle[2].trim() } : { address: angle[2].trim() }
  }
  return { address: t.replace(/^mailto:/i, '') }
}

export function parseAddressList(raw: string): EmailAddress[] {
  return splitAddressList(raw).map(parseAddress).filter((a) => a.address.length > 0)
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

export function dedupeAddresses(list: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>()
  const out: EmailAddress[] = []
  for (const a of list) {
    const key = a.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h}:${m < 10 ? '0' : ''}${m}`
}

export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function totalAttachmentBytes(list: ComposeAttachment[]): number {
  return list.reduce((sum, a) => sum + (a.size || 0), 0)
}

export function newContentId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `estuary-${rand.replace(/-/g, '')}@estuary.local`
}

// ---------------------------------------------------------------------------
// HTML body: signature + quoted original
// ---------------------------------------------------------------------------

function parseFragment(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = html ?? ''
  return host
}

export interface SplitBody {
  /** Everything the user edits. */
  body: string
  /** The `<div class="estuary-quote">…</div>` block, or '' when there is none. */
  quote: string
}

/** Separate the editable body from the quoted original that main pre-filled. */
export function splitQuote(html: string): SplitBody {
  if (!html) return { body: '', quote: '' }
  if (!html.includes(QUOTE_CLASS)) return { body: html, quote: '' }
  const host = parseFragment(html)
  const quoteEl = host.querySelector(`.${QUOTE_CLASS}`)
  if (!quoteEl) return { body: html, quote: '' }
  const quote = quoteEl.outerHTML
  quoteEl.remove()
  return { body: host.innerHTML, quote }
}

/** Re-join the edited body and the quote for saving/sending. */
export function joinQuote(body: string, quote: string): string {
  if (!quote) return body
  return `${body}\n${quote}`
}

/** Extract the current signature block's outer HTML, if the body still contains one. */
export function findSignatureHtml(html: string): string | null {
  if (!html || !html.includes(SIGNATURE_CLASS)) return null
  const el = parseFragment(html).querySelector(`.${SIGNATURE_CLASS}`)
  return el ? el.outerHTML : null
}

export function wrapSignature(signature: string | undefined): string {
  if (!signature || !signature.trim()) return ''
  return `<div class="${SIGNATURE_CLASS}">${signature}</div>`
}

/**
 * Swap the signature block when the From account changes.
 * Only touches the body when it still holds an untouched `.estuary-signature` block;
 * if the user deleted it we leave the body alone rather than re-inserting.
 */
export function replaceSignature(html: string, nextSignature: string | undefined): string {
  const next = wrapSignature(nextSignature)
  const host = parseFragment(html)
  const el = host.querySelector(`.${SIGNATURE_CLASS}`)
  if (!el) return html
  if (!next) {
    el.remove()
    return host.innerHTML
  }
  const replacement = parseFragment(next).firstElementChild
  if (!replacement) return html
  el.replaceWith(replacement)
  return host.innerHTML
}

/** Append a signature block to a body that does not have one yet. */
export function appendSignature(html: string, signature: string | undefined): string {
  const sig = wrapSignature(signature)
  if (!sig) return html
  if (html.includes(SIGNATURE_CLASS)) return html
  return `${html}<p></p>${sig}`
}

/** Visible text of an HTML fragment, used for empty checks and the "attach" heuristic. */
export function htmlToText(html: string): string {
  if (!html) return ''
  return parseFragment(html).textContent?.replace(/ /g, ' ') ?? ''
}

export function isBodyEmpty(html: string): boolean {
  if (!html) return true
  const host = parseFragment(html)
  host.querySelectorAll(`.${SIGNATURE_CLASS}, .${QUOTE_CLASS}`).forEach((n) => n.remove())
  if (host.querySelector('img')) return false
  return (host.textContent ?? '').trim().length === 0
}

const ATTACH_WORDS = /\b(attach(ed|ing|ment|ments)?|enclosed|enclosing)\b/i

/** True when the text talks about an attachment - used to warn before sending without one. */
export function mentionsAttachment(html: string): boolean {
  const host = parseFragment(html)
  host.querySelectorAll(`.${QUOTE_CLASS}`).forEach((n) => n.remove())
  return ATTACH_WORDS.test(host.textContent ?? '')
}

/**
 * Inline images live in the editor as data: URLs (so they render) but must be sent as
 * `cid:` references. This rewrites them right before save/send.
 */
export function dataUrlsToCid(html: string, attachments: ComposeAttachment[]): string {
  const inline = attachments.filter((a) => a.contentId && a.contentBase64)
  if (!inline.length || !html.includes('data:')) return html
  const host = parseFragment(html)
  host.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith('data:')) return
    const b64 = src.slice(src.indexOf(',') + 1)
    const match = inline.find((a) => a.contentBase64 === b64)
    if (match?.contentId) img.setAttribute('src', `cid:${match.contentId}`)
  })
  return host.innerHTML
}

/** The reverse, so a re-opened draft shows its inline images. */
export function cidToDataUrls(html: string, attachments: ComposeAttachment[]): string {
  if (!html.includes('cid:')) return html
  const host = parseFragment(html)
  host.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith('cid:')) return
    const cid = src.slice(4)
    const match = attachments.find((a) => a.contentId === cid && a.contentBase64)
    if (match) img.setAttribute('src', `data:${match.contentType};base64,${match.contentBase64}`)
  })
  return host.innerHTML
}

/** Read a dropped/pasted File as base64 (no `path` needed, works in sandboxed renderers). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function windowTitleFor(subject: string, mode?: string): string {
  const s = subject.trim()
  if (!s) return 'New message'
  if (mode === 'reply' || mode === 'replyAll') return s.startsWith('Re:') ? s : `Re: ${s}`
  return s
}
