/**
 * Pure formatting helpers for the renderer. No React, no side effects.
 */
import type { EmailAddress, ThreadSummary } from '@shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * List-style relative date: 'now', '5m', '13:42' (today), 'Tue' (this week),
 * 'Mar 3' (this year), '3/3/25' (older).
 */
export function relativeDate(ts: number, now: number = Date.now()): string {
  if (!ts) return ''
  const d = new Date(ts)
  const n = new Date(now)
  const diff = now - ts
  if (diff < 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (sameDay(d, n)) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diff < 7 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' })
}

/** Full date used in the reader header and tooltips. */
export function fullDate(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Reader message header date: 'Mar 3, 13:42' or 'Mar 3, 2024, 13:42'. */
export function messageDate(ts: number, now: number = Date.now()): string {
  if (!ts) return ''
  const d = new Date(ts)
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric'
  return d.toLocaleString(undefined, opts)
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${Math.round(n / 1000)}k`
}

/** Display name for an address: name if present, else the local part, else the address. */
export function displayName(a: EmailAddress | undefined): string {
  if (!a) return ''
  if (a.name && a.name.trim()) return a.name.trim()
  const at = a.address.indexOf('@')
  return at > 0 ? a.address.slice(0, at) : a.address
}

/** First name only, used to keep participant lists short. */
export function shortName(a: EmailAddress | undefined): string {
  const n = displayName(a)
  if (!n) return ''
  if (n.includes('@')) return n
  const first = n.split(/[\s,]+/)[0]
  return first.length >= 2 ? first : n
}

export function initialsFor(name?: string, address?: string): string {
  const source = (name && name.trim()) || (address ?? '')
  if (!source) return '?'
  const cleaned = source.replace(/[^\p{L}\p{N}\s._-]/gu, ' ').trim()
  if (!cleaned) return '?'
  const local = cleaned.includes('@') ? cleaned.split('@')[0] : cleaned
  const parts = local.split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export interface ParticipantOptions {
  /** Addresses belonging to the user; rendered as 'me'. */
  meAddresses?: string[]
  max?: number
}

/**
 * Participant summary for a list row: 'Ana, me, Bob +3'.
 */
export function formatParticipants(participants: EmailAddress[], opts: ParticipantOptions = {}): string {
  const { meAddresses = [], max = 3 } = opts
  const me = new Set(meAddresses.map((a) => a.toLowerCase()))
  const seen = new Set<string>()
  const names: string[] = []
  for (const p of participants) {
    const key = p.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(me.has(key) ? 'me' : shortName(p))
  }
  if (names.length === 0) return '(no sender)'
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} +${names.length - max}`
}

/** Full 'Name <address>' list, used in the reader's to/cc details. */
export function formatAddressList(list: EmailAddress[], meAddresses: string[] = []): string {
  const me = new Set(meAddresses.map((a) => a.toLowerCase()))
  if (list.length === 0) return '—'
  return list
    .map((a) => (me.has(a.address.toLowerCase()) ? 'me' : a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ')
}

export function subjectOrFallback(subject: string): string {
  const s = (subject ?? '').trim()
  return s.length > 0 ? s : '(no subject)'
}

/** Sort key helper so unified lists merge deterministically. */
export function byLastDateDesc(a: ThreadSummary, b: ThreadSummary): number {
  return b.lastDate - a.lastDate || a.id.localeCompare(b.id)
}

/** Escape for safe insertion into HTML we build ourselves (plain-text bodies). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?])/gi

/** Turn a plain-text body into escaped HTML with clickable links. */
export function linkifyPlainText(text: string): string {
  const escaped = escapeHtml(text)
  const linked = escaped.replace(URL_RE, (m) => {
    const href = m.startsWith('http') ? m : `https://${m}`
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${m}</a>`
  })
  return linked.replace(
    /^((?:&gt;\s?)+)(.*)$/gm,
    (_m, q: string, rest: string) => `<span class="quote">${q}${rest}</span>`
  )
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
