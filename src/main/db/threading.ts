/**
 * Pure threading logic. No SQL here — the store passes in lookup callbacks so this file
 * stays unit-testable.
 *
 * Rules, in order:
 *   1. Gmail X-GM-THRID wins when present.
 *   2. Otherwise any already-stored message referenced by (or referencing) this one decides
 *      the thread. When that turns up more than one thread, they get merged.
 *   3. Otherwise a normalised-subject match in the same account, within 7 days, with at least
 *      one participant in common.
 *   4. Otherwise a brand new thread.
 */

/** Window used by the subject fallback. */
export const SUBJECT_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const SUBJECT_PREFIX_RE =
  /^\s*(?:(?:re|r|ref|fw|fwd|fwd?s|aw|antw|antwort|sv|vs|vb|wg|rif|res|enc|tr|odp|ynt|betr|доб|回复|答复|回覆|转发|轉寄)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i

/** Strip Re:/Fwd:/AW:/… prefixes, collapse whitespace, lowercase. */
export function normaliseSubject(subject: string | undefined | null): string {
  let s = (subject ?? '').replace(/\s+/g, ' ').trim()
  // Repeatedly strip prefixes: "Re: Fwd: Re: x" -> "x"
  for (let i = 0; i < 10; i += 1) {
    const next = s.replace(SUBJECT_PREFIX_RE, '')
    if (next === s) break
    s = next.trim()
  }
  return s.toLowerCase().trim()
}

/** Lowercase, trimmed address with angle brackets removed. */
export function normaliseAddress(address: string | undefined | null): string {
  return (address ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase()
}

/** Strip angle brackets/whitespace from a Message-ID header value. */
export function normaliseMessageId(id: string | undefined | null): string {
  return (id ?? '').trim().replace(/^</, '').replace(/>$/, '').trim()
}

/** Split a References header (or an already-split array) into normalised message ids. */
export function parseReferences(refs: string | string[] | undefined | null): string[] {
  if (!refs) return []
  const list = Array.isArray(refs) ? refs : refs.split(/\s+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    for (const part of String(raw).split(/\s+/)) {
      const id = normaliseMessageId(part)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export interface SubjectThreadCandidate {
  threadId: string
  /** Normalised participant addresses already in the thread. */
  participants: string[]
  lastDate: number
  firstDate?: number
}

/** Lookups into what is already stored. All of them are cheap indexed queries in the store. */
export interface ThreadLookups {
  /** Thread id for a Gmail X-GM-THRID within the account, if one exists. */
  byGmThrid(gmThrid: string): string | undefined
  /** Thread ids of stored messages whose Message-ID header is one of `messageIds`. */
  byMessageIds(messageIds: string[]): string[]
  /** Thread ids of stored messages whose In-Reply-To/References mention `messageId`. */
  byReferencing?(messageId: string): string[]
  /** Threads in the same account with this normalised subject whose lastDate is within the window. */
  bySubject(subjectNorm: string, fromDate: number, toDate: number): SubjectThreadCandidate[]
}

export interface ThreadInput {
  accountId: string
  messageIdHeader?: string
  inReplyTo?: string
  references?: string[]
  gmThrid?: string
  subject?: string
  /** Every address on the message (from/to/cc), normalised or not. */
  participants: string[]
  date: number
}

export type ThreadReason = 'gmail' | 'references' | 'subject' | 'new'

export interface ThreadResolution {
  /** Existing threads this message belongs to. Empty = start a new thread. More than one = merge. */
  threadIds: string[]
  reason: ThreadReason
  /** Normalised subject, so the caller can store it without recomputing. */
  subjectNorm: string
}

function uniq(values: (string | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Decide which existing thread(s) a message belongs to.
 * Returns every matching thread id; when there is more than one the caller merges them
 * (keeping the biggest and reassigning the smaller ones).
 */
export function resolveThread(input: ThreadInput, lookups: ThreadLookups): ThreadResolution {
  const subjectNorm = normaliseSubject(input.subject)

  // 1. Gmail thread id.
  if (input.gmThrid) {
    const existing = lookups.byGmThrid(input.gmThrid)
    return { threadIds: existing ? [existing] : [], reason: 'gmail', subjectNorm }
  }

  // 2. Reference chain, in both directions.
  const selfId = normaliseMessageId(input.messageIdHeader)
  const referenced = uniq([
    normaliseMessageId(input.inReplyTo) || undefined,
    ...parseReferences(input.references)
  ]).filter((id) => id !== selfId)

  const found: string[] = []
  if (referenced.length > 0) found.push(...lookups.byMessageIds(referenced))
  if (selfId && lookups.byReferencing) found.push(...lookups.byReferencing(selfId))
  const linked = uniq(found)
  if (linked.length > 0) return { threadIds: linked, reason: 'references', subjectNorm }

  // 3. Normalised subject + participant overlap within 7 days.
  if (subjectNorm) {
    const participants = new Set(input.participants.map(normaliseAddress).filter(Boolean))
    const candidates = lookups.bySubject(
      subjectNorm,
      input.date - SUBJECT_THREAD_WINDOW_MS,
      input.date + SUBJECT_THREAD_WINDOW_MS
    )
    const matches = candidates.filter((c) => {
      const first = c.firstDate ?? c.lastDate
      const withinWindow =
        input.date >= first - SUBJECT_THREAD_WINDOW_MS && input.date <= c.lastDate + SUBJECT_THREAD_WINDOW_MS
      if (!withinWindow) return false
      if (participants.size === 0) return false
      return c.participants.some((p) => participants.has(normaliseAddress(p)))
    })
    if (matches.length > 0) {
      // Closest in time first, so the primary pick is the most plausible parent.
      matches.sort((a, b) => Math.abs(a.lastDate - input.date) - Math.abs(b.lastDate - input.date))
      return { threadIds: uniq(matches.map((m) => m.threadId)), reason: 'subject', subjectNorm }
    }
  }

  // 4. New thread.
  return { threadIds: [], reason: 'new', subjectNorm }
}

/**
 * Given thread ids and their message counts, pick which thread survives a merge.
 * The biggest thread wins; ties break on the earliest thread (stable, id-ordered).
 */
export function pickMergeTarget(threads: { id: string; messageCount: number; firstDate?: number }[]): {
  keep: string
  merge: string[]
} {
  if (threads.length === 0) throw new Error('pickMergeTarget: no threads')
  const sorted = [...threads].sort((a, b) => {
    if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount
    const af = a.firstDate ?? Number.MAX_SAFE_INTEGER
    const bf = b.firstDate ?? Number.MAX_SAFE_INTEGER
    if (af !== bf) return af - bf
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const keep = sorted[0] as { id: string }
  return { keep: keep.id, merge: sorted.slice(1).map((t) => t.id) }
}
