/**
 * Pure search-query parser.
 *
 * Turns a Gmail-ish query string into
 *   - an FTS5 MATCH expression for `messages_fts(subject, sender, recipients, body)`
 *   - SQL WHERE fragments (referencing the `m` messages alias and the `fo` folders alias)
 *   - the parameters for those fragments
 *
 * Supported: from:, to:, cc:, subject:, body:, in:<folder kind>, has:attachment,
 * is:unread|read|starred|flagged|draft|answered, before:YYYY-MM-DD, after:YYYY-MM-DD,
 * "quoted phrases" and free text. A leading `-` negates from:/to:/subject:/free text.
 */
import type { FolderKind } from '@shared/types'

const FOLDER_KINDS: FolderKind[] = [
  'inbox',
  'sent',
  'drafts',
  'trash',
  'spam',
  'archive',
  'all',
  'starred',
  'important',
  'custom'
]

export interface ParsedSearch {
  /** FTS5 MATCH expression, or '' when the query has no text terms. */
  fts: string
  /** SQL fragments, ANDed together. They use the `m` (messages) and `fo` (folders) aliases. */
  where: string[]
  /** Parameters for `where`, in order. */
  params: (string | number)[]
  /** True when a fragment references the folders alias. */
  needsFolders: boolean
  /** Parsed pieces, exposed for tests and for UI chips. */
  terms: {
    text: string[]
    phrases: string[]
    from: string[]
    to: string[]
    cc: string[]
    subject: string[]
    body: string[]
    in: FolderKind[]
    hasAttachment: boolean
    isUnread: boolean
    isRead: boolean
    isStarred: boolean
    isDraft: boolean
    isAnswered: boolean
    before?: number
    after?: number
    negated: string[]
  }
}

interface Token {
  key?: string
  value: string
  quoted: boolean
  negated: boolean
}

/** Escape a user token so it is a safe FTS5 string literal. */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

function tokenize(q: string): Token[] {
  const tokens: Token[] = []
  const re = /(-)?(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(q)) !== null) {
    const [, neg, key, quoted, bare] = match
    const value = quoted !== undefined ? quoted : (bare ?? '')
    if (value.trim() === '') continue
    tokens.push({
      key: key ? key.toLowerCase() : undefined,
      value: value.trim(),
      quoted: quoted !== undefined,
      negated: neg === '-'
    })
  }
  return tokens
}

/** Parse YYYY-MM-DD (or YYYY/MM/DD) into epoch ms at local midnight. */
export function parseDateToken(value: string): number | undefined {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim())
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const d = new Date(year, month - 1, day, 0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? undefined : d.getTime()
}

function ftsColumnTerm(column: string, value: string, prefix: boolean): string {
  return `${column} : ${escapeFtsToken(value)}${prefix ? '*' : ''}`
}

export function parseSearchQuery(q: string): ParsedSearch {
  const terms: ParsedSearch['terms'] = {
    text: [],
    phrases: [],
    from: [],
    to: [],
    cc: [],
    subject: [],
    body: [],
    in: [],
    hasAttachment: false,
    isUnread: false,
    isRead: false,
    isStarred: false,
    isDraft: false,
    isAnswered: false,
    negated: []
  }

  const where: string[] = []
  const params: (string | number)[] = []
  let needsFolders = false
  const ftsParts: string[] = []
  const freeTokens: Token[] = []

  for (const token of tokenize(q ?? '')) {
    const { key, value, negated } = token
    switch (key) {
      case 'from':
        if (negated) {
          terms.negated.push(`from:${value}`)
          ftsParts.push(`NOT ${ftsColumnTerm('sender', value, false)}`)
        } else {
          terms.from.push(value)
          ftsParts.push(ftsColumnTerm('sender', value, !token.quoted))
        }
        break
      case 'to':
        if (negated) {
          terms.negated.push(`to:${value}`)
          ftsParts.push(`NOT ${ftsColumnTerm('recipients', value, false)}`)
        } else {
          terms.to.push(value)
          ftsParts.push(ftsColumnTerm('recipients', value, !token.quoted))
        }
        break
      case 'cc':
        terms.cc.push(value)
        ftsParts.push(ftsColumnTerm('recipients', value, !token.quoted))
        break
      case 'subject':
      case 'title':
        if (negated) {
          terms.negated.push(`subject:${value}`)
          ftsParts.push(`NOT ${ftsColumnTerm('subject', value, false)}`)
        } else {
          terms.subject.push(value)
          ftsParts.push(ftsColumnTerm('subject', value, !token.quoted))
        }
        break
      case 'body':
        terms.body.push(value)
        ftsParts.push(ftsColumnTerm('body', value, !token.quoted))
        break
      case 'has':
        if (value.toLowerCase().startsWith('attach')) {
          terms.hasAttachment = true
          where.push('m.has_attachments = 1')
        }
        break
      case 'is':
        switch (value.toLowerCase()) {
          case 'unread':
          case 'new':
            terms.isUnread = true
            where.push('m.seen = 0')
            break
          case 'read':
            terms.isRead = true
            where.push('m.seen = 1')
            break
          case 'starred':
          case 'flagged':
            terms.isStarred = true
            where.push('m.flagged = 1')
            break
          case 'draft':
            terms.isDraft = true
            where.push('m.draft = 1')
            break
          case 'answered':
          case 'replied':
            terms.isAnswered = true
            where.push('m.answered = 1')
            break
          default:
            break
        }
        break
      case 'in':
      case 'folder':
      case 'label': {
        const kind = value.toLowerCase() as FolderKind
        if (FOLDER_KINDS.includes(kind)) {
          terms.in.push(kind)
          where.push('fo.kind = ?')
          params.push(kind)
          needsFolders = true
        } else {
          // Unknown label: treat it as a folder path/name match.
          where.push('(fo.name = ? COLLATE NOCASE OR fo.path = ? COLLATE NOCASE)')
          params.push(value, value)
          needsFolders = true
        }
        break
      }
      case 'before': {
        const ts = parseDateToken(value)
        if (ts !== undefined) {
          terms.before = ts
          where.push('m.date < ?')
          params.push(ts)
        }
        break
      }
      case 'after':
      case 'since': {
        const ts = parseDateToken(value)
        if (ts !== undefined) {
          terms.after = ts
          where.push('m.date >= ?')
          params.push(ts)
        }
        break
      }
      default:
        freeTokens.push(token)
        break
    }
  }

  // Free text: every token ANDed, prefix-matching only the last unquoted one.
  const lastFreeIndex = (() => {
    for (let i = freeTokens.length - 1; i >= 0; i -= 1) {
      const t = freeTokens[i] as Token
      if (!t.quoted && !t.negated) return i
    }
    return -1
  })()

  freeTokens.forEach((token, index) => {
    if (token.quoted) terms.phrases.push(token.value)
    else terms.text.push(token.value)
    if (token.negated) {
      terms.negated.push(token.value)
      ftsParts.push(`NOT ${escapeFtsToken(token.value)}`)
      return
    }
    const prefix = index === lastFreeIndex && !token.quoted && /[^\s"]$/.test(token.value)
    ftsParts.push(`${escapeFtsToken(token.value)}${prefix ? '*' : ''}`)
  })

  // FTS5 cannot start an expression with NOT; drop leading negations in that case.
  let fts = ''
  const positive = ftsParts.filter((p) => !p.startsWith('NOT '))
  const negative = ftsParts.filter((p) => p.startsWith('NOT '))
  if (positive.length > 0) {
    fts = [...positive, ...negative].join(' AND ')
  } else if (negative.length > 0) {
    // Nothing positive to anchor a NOT on — ignore the negations rather than error.
    fts = ''
  }

  return { fts, where, params, needsFolders, terms }
}
