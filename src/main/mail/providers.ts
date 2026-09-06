/**
 * Provider quirks for the mail engine.
 *
 * Pure module (no imports from imapflow / electron) so it can be unit tested:
 *  - folder path/attribute -> FolderKind mapping
 *  - archive strategy, Sent auto-save behaviour, connection budget
 *  - which folder kinds are synced by default
 */
import type { FolderKind, ProviderId } from '@shared/types'

export type ArchiveStrategy =
  /** Gmail: "archive" means remove the INBOX label -> MOVE to [Gmail]/All Mail */
  | 'gmailAllMail'
  /** Everyone else: MOVE to the folder of kind `archive` (create `Archive` if absent) */
  | 'archiveFolder'

/** Minimal shape of an imapflow LIST entry (kept structural so tests need no imapflow). */
export interface MailboxInfo {
  path: string
  name?: string
  delimiter?: string
  /** e.g. '\\Sent' */
  specialUse?: string
  /** LIST flags, e.g. new Set(['\\HasNoChildren', '\\Sent']) */
  flags?: Iterable<string>
  subscribed?: boolean
}

export interface ProviderQuirks {
  id: ProviderId
  label: string
  /** Max simultaneous IMAP connections the server tolerates for one account. */
  maxConnections: number
  /** True when the SMTP server files a copy in Sent by itself (no APPEND needed). */
  smtpAutoSavesSent: boolean
  archiveStrategy: ArchiveStrategy
  /** Create an `Archive` mailbox on demand when the account has none. */
  createArchiveIfMissing: boolean
  /** Folder kinds the sync engine keeps up to date by default. */
  defaultSyncedKinds: FolderKind[]
  /** True when one folder mirrors every message (Gmail All Mail) - never double-fetch bodies there. */
  hasSupersetFolder: boolean
  /** Folder kinds whose newest messages get their bodies prefetched. */
  bodyPrefetchKinds: FolderKind[]
  /** Gmail exposes X-GM-EXT-1 (labels / thread ids / msg ids). */
  gmailExtensions: boolean
}

const BASE_SYNCED: FolderKind[] = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam']

const QUIRKS: Record<ProviderId, ProviderQuirks> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    maxConnections: 15,
    smtpAutoSavesSent: true,
    archiveStrategy: 'gmailAllMail',
    createArchiveIfMissing: false,
    defaultSyncedKinds: [...BASE_SYNCED, 'all'],
    hasSupersetFolder: true,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: true
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook',
    // Microsoft allows ~20 but throttles aggressively; stay gentle.
    maxConnections: 8,
    smtpAutoSavesSent: true,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  },
  spacemail: {
    id: 'spacemail',
    label: 'Spacemail',
    maxConnections: 3,
    smtpAutoSavesSent: false,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud',
    maxConnections: 3,
    smtpAutoSavesSent: false,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo',
    maxConnections: 4,
    smtpAutoSavesSent: false,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  },
  fastmail: {
    id: 'fastmail',
    label: 'Fastmail',
    maxConnections: 5,
    smtpAutoSavesSent: false,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  },
  imap: {
    id: 'imap',
    label: 'IMAP',
    maxConnections: 3,
    smtpAutoSavesSent: false,
    archiveStrategy: 'archiveFolder',
    createArchiveIfMissing: true,
    defaultSyncedKinds: BASE_SYNCED,
    hasSupersetFolder: false,
    bodyPrefetchKinds: ['inbox'],
    gmailExtensions: false
  }
}

export function providerQuirks(provider: ProviderId | undefined): ProviderQuirks {
  return QUIRKS[(provider ?? 'imap') as ProviderId] ?? QUIRKS.imap
}

// ---------------------------------------------------------------------------
// Folder kind mapping
// ---------------------------------------------------------------------------

/** RFC 6154 SPECIAL-USE attributes (plus Gmail's \Important / \Inbox). */
const SPECIAL_USE: Record<string, FolderKind> = {
  '\\inbox': 'inbox',
  '\\all': 'all',
  '\\allmail': 'all',
  '\\archive': 'archive',
  '\\drafts': 'drafts',
  '\\draft': 'drafts',
  '\\flagged': 'starred',
  '\\starred': 'starred',
  '\\junk': 'spam',
  '\\spam': 'spam',
  '\\sent': 'sent',
  '\\trash': 'trash',
  '\\deleted': 'trash',
  '\\important': 'important'
}

/**
 * Localised leaf names. Keys are lowercase, punctuation-normalised.
 * Order matters only in that the first kind whose list contains the name wins.
 */
const NAME_KINDS: [FolderKind, string[]][] = [
  [
    'sent',
    [
      'sent',
      'sent items',
      'sent mail',
      'sent messages',
      'sentmail',
      'outbox sent',
      'enviados',
      'elementos enviados',
      'correo enviado',
      'envoyes',
      'elements envoyes',
      'messages envoyes',
      'gesendet',
      'gesendete elemente',
      'gesendete objekte',
      'posta inviata',
      'inviata',
      'verzonden',
      'verzonden items',
      'skickat',
      'skickade meddelanden',
      'enviadas',
      'itens enviados',
      'wyslane',
      'otpravlennye',
      'otpravlenye'
    ]
  ],
  [
    'drafts',
    [
      'draft',
      'drafts',
      'borradores',
      'brouillons',
      'entwurfe',
      'entwuerfe',
      'bozze',
      'concepten',
      'utkast',
      'rascunhos',
      'kopie robocze',
      'chernoviki'
    ]
  ],
  [
    'trash',
    [
      'trash',
      'bin',
      'deleted',
      'deleted items',
      'deleted messages',
      'trash bin',
      'recycle bin',
      'papelera',
      'elementos eliminados',
      'corbeille',
      'elements supprimes',
      'papierkorb',
      'geloschte elemente',
      'geloeschte elemente',
      'cestino',
      'prullenbak',
      'papperskorg',
      'lixeira',
      'itens excluidos',
      'kosz',
      'korzina',
      'udalennye'
    ]
  ],
  [
    'spam',
    [
      'spam',
      'junk',
      'junk mail',
      'junk email',
      'junk e mail',
      'bulk mail',
      'correo no deseado',
      'no deseado',
      'courrier indesirable',
      'indesirables',
      'pourriel',
      'werbung',
      'posta indesiderata',
      'indesiderata',
      'ongewenst',
      'ongewenste e mail',
      'skrappost',
      'lixo eletronico',
      'niechciane'
    ]
  ],
  [
    'archive',
    ['archive', 'archives', 'archiv', 'archivio', 'archivo', 'archief', 'arkiv', 'arquivo', 'archiwum', 'arhiv']
  ],
  [
    'all',
    [
      'all mail',
      'all messages',
      'allmail',
      'todos',
      'todos los mensajes',
      'tous les messages',
      'alle nachrichten',
      'tutti i messaggi',
      'alle berichten',
      'alla meddelanden',
      'vsya pochta'
    ]
  ],
  [
    'starred',
    ['starred', 'flagged', 'with stars', 'destacados', 'favoritos', 'suivis', 'markiert', 'speciali', 'met ster', 'stjarnmarkerat']
  ],
  ['important', ['important', 'importante', 'importants', 'wichtig', 'belangrijk', 'priority']]
]

const PATH_PREFIXES = ['[gmail]/', '[google mail]/', 'inbox.', 'inbox/', 'inbox|']

/** Gmail's canonical English paths (used when SPECIAL-USE is missing). */
const GMAIL_PATHS: Record<string, FolderKind> = {
  'all mail': 'all',
  'sent mail': 'sent',
  sent: 'sent',
  spam: 'spam',
  trash: 'trash',
  bin: 'trash',
  drafts: 'drafts',
  starred: 'starred',
  important: 'important'
}

/** Outlook's canonical English paths. */
const OUTLOOK_PATHS: Record<string, FolderKind> = {
  'sent items': 'sent',
  'deleted items': 'trash',
  'junk email': 'spam',
  archive: 'archive',
  drafts: 'drafts',
  notes: 'custom',
  'conversation history': 'custom',
  'rss feeds': 'custom',
  outbox: 'custom'
}

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectAttributes(box: MailboxInfo): string[] {
  const out: string[] = []
  if (box.specialUse) out.push(box.specialUse.toLowerCase())
  if (box.flags) for (const f of box.flags) if (typeof f === 'string') out.push(f.toLowerCase())
  return out
}

/** Path with the provider container / INBOX prefix removed, using '/' as delimiter. */
export function strippedPath(box: MailboxInfo): string {
  const delimiter = box.delimiter && box.delimiter.length === 1 ? box.delimiter : '/'
  let path = box.path.split(delimiter).join('/')
  const lower = path.toLowerCase()
  for (const prefix of PATH_PREFIXES) {
    if (lower.startsWith(prefix)) {
      path = path.slice(prefix.length)
      break
    }
  }
  return path
}

export function leafName(box: MailboxInfo): string {
  if (box.name && box.name.length) return box.name
  const delimiter = box.delimiter && box.delimiter.length === 1 ? box.delimiter : '/'
  const parts = box.path.split(delimiter)
  return parts[parts.length - 1] ?? box.path
}

/**
 * Map one mailbox to a FolderKind.
 * SPECIAL-USE attributes win; then provider-specific canonical paths; then localised names.
 */
export function mapFolderKind(provider: ProviderId | undefined, box: MailboxInfo): FolderKind {
  if (!box.path) return 'custom'
  if (box.path.toUpperCase() === 'INBOX') return 'inbox'

  for (const attribute of collectAttributes(box)) {
    const kind = SPECIAL_USE[attribute]
    if (kind) return kind
  }

  const stripped = strippedPath(box)
  const strippedNorm = normalise(stripped)
  const depth = stripped.split('/').filter(Boolean).length

  if (provider === 'gmail') {
    const kind = GMAIL_PATHS[strippedNorm]
    if (kind) return kind
  }
  if (provider === 'outlook') {
    const kind = OUTLOOK_PATHS[strippedNorm]
    if (kind) return kind
  }

  // Only trust name heuristics for top-level folders; a user folder called
  // "Clients/Archive" must stay custom.
  if (depth > 1) return 'custom'

  const leaf = normalise(leafName(box))
  for (const [kind, names] of NAME_KINDS) {
    if (names.includes(strippedNorm) || names.includes(leaf)) return kind
  }
  return 'custom'
}

export interface MappedFolder {
  path: string
  name: string
  delimiter: string
  kind: FolderKind
  synced: boolean
}

/**
 * Map a whole LIST response. Guarantees at most one folder per non-custom kind
 * (the first, shallowest match wins; later duplicates fall back to 'custom').
 */
export function mapFolders(provider: ProviderId | undefined, boxes: MailboxInfo[]): MappedFolder[] {
  const quirks = providerQuirks(provider)
  const taken = new Set<FolderKind>()
  const scored = boxes.map((box, index) => ({
    box,
    index,
    kind: mapFolderKind(provider, box),
    depth: strippedPath(box).split('/').filter(Boolean).length
  }))
  // Resolve duplicates deterministically: INBOX first, then shallowest, then LIST order.
  const order = [...scored].sort((a, b) => {
    const aInbox = a.box.path.toUpperCase() === 'INBOX' ? 0 : 1
    const bInbox = b.box.path.toUpperCase() === 'INBOX' ? 0 : 1
    if (aInbox !== bInbox) return aInbox - bInbox
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.index - b.index
  })
  const kinds = new Map<number, FolderKind>()
  for (const entry of order) {
    let kind = entry.kind
    if (kind !== 'custom') {
      if (taken.has(kind)) kind = 'custom'
      else taken.add(kind)
    }
    kinds.set(entry.index, kind)
  }
  return scored.map((entry) => {
    const kind = kinds.get(entry.index) ?? 'custom'
    return {
      path: entry.box.path,
      name: leafName(entry.box),
      delimiter: entry.box.delimiter && entry.box.delimiter.length ? entry.box.delimiter : '/',
      kind,
      synced: shouldSync(quirks, kind)
    }
  })
}

export function shouldSync(quirks: ProviderQuirks, kind: FolderKind): boolean {
  return quirks.defaultSyncedKinds.includes(kind)
}

/** Folder kind an `archive` action should move a message into. */
export function archiveTargetKind(quirks: ProviderQuirks): FolderKind {
  return quirks.archiveStrategy === 'gmailAllMail' ? 'all' : 'archive'
}

/**
 * Build the IMAP path for a new mailbox.
 * Servers that expose everything below INBOX (Courier, some Dovecot setups) need the prefix.
 */
export function buildFolderPath(name: string, options: { parentPath?: string; delimiter: string; inboxPrefixed: boolean }): string {
  const delimiter = options.delimiter && options.delimiter.length ? options.delimiter : '/'
  const clean = name.split(delimiter).join(' ').trim()
  if (options.parentPath) return `${options.parentPath}${delimiter}${clean}`
  if (options.inboxPrefixed) return `INBOX${delimiter}${clean}`
  return clean
}

/** True when every non-INBOX folder lives below INBOX (Spacemail/Courier style). */
export function detectInboxPrefixed(paths: string[], delimiter: string): boolean {
  const others = paths.filter((p) => p.toUpperCase() !== 'INBOX')
  if (!others.length) return false
  const prefix = `INBOX${delimiter}`
  return others.every((p) => p.toUpperCase().startsWith(prefix.toUpperCase()))
}
