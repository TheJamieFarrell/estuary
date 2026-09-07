/**
 * In-memory RendererApi used when `window.api` is missing (plain `vite` / browser dev)
 * and by the sibling renderer agent for compose/settings/accounts work.
 * Seeded and deterministic: three accounts, ~120 threads, realistic bodies.
 */
import type {
  Account,
  AppSettings,
  AttachmentMeta,
  ComposePayload,
  Draft,
  EmailAddress,
  Folder,
  FolderKind,
  MessageFull,
  MessageListQuery,
  MessageListResult,
  ProviderPreset,
  SyncStatus,
  ThreadSummary,
  UnreadCounts
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcReq, IpcRes, RendererApi } from '@shared/ipc'

// ---------------------------------------------------------------------------
// deterministic RNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(20260906)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]
const chance = (p: number): boolean => rnd() < p
const uid = (() => {
  let n = 1
  return (prefix: string) => `${prefix}_${(n++).toString(36).padStart(4, '0')}`
})()

const NOW = Date.UTC(2026, 8, 6, 15, 30)

// ---------------------------------------------------------------------------
// accounts + folders
// ---------------------------------------------------------------------------
const ACCOUNTS: Account[] = [
  {
    id: 'acc_gmail',
    email: 'jamie.farrell@gmail.com',
    name: 'Jamie Farrell',
    provider: 'gmail',
    authType: 'oauth2',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    username: 'jamie.farrell@gmail.com',
    color: '#d93025',
    signature: '<p>— Jamie</p>',
    createdAt: NOW - 400 * 864e5,
    lastSyncAt: NOW - 60_000,
    cacheLimit: 5000,
    enabled: true
  },
  {
    id: 'acc_outlook',
    email: 'j.farrell@outlook.com',
    name: 'Jamie Farrell',
    provider: 'outlook',
    authType: 'oauth2',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    username: 'j.farrell@outlook.com',
    color: '#0f6cbd',
    createdAt: NOW - 300 * 864e5,
    lastSyncAt: NOW - 120_000,
    cacheLimit: 5000,
    enabled: true
  },
  {
    id: 'acc_space',
    email: 'jamie@tfc.consulting',
    name: 'Jamie Farrell — TFC',
    provider: 'spacemail',
    authType: 'password',
    imap: { host: 'mail.spacemail.com', port: 993, secure: true },
    smtp: { host: 'mail.spacemail.com', port: 465, secure: true },
    username: 'jamie@tfc.consulting',
    color: '#2e9e5b',
    signature: '<p>Jamie Farrell<br>TFC Consultancy</p>',
    createdAt: NOW - 220 * 864e5,
    lastSyncAt: NOW - 30_000,
    cacheLimit: 5000,
    enabled: true
  }
]

interface FolderSeed {
  path: string
  name: string
  kind: FolderKind
  delimiter: string
}

const FOLDER_SEEDS: Record<string, FolderSeed[]> = {
  acc_gmail: [
    { path: 'INBOX', name: 'Inbox', kind: 'inbox', delimiter: '/' },
    { path: '[Gmail]/Sent Mail', name: 'Sent Mail', kind: 'sent', delimiter: '/' },
    { path: '[Gmail]/Drafts', name: 'Drafts', kind: 'drafts', delimiter: '/' },
    { path: '[Gmail]/All Mail', name: 'All Mail', kind: 'archive', delimiter: '/' },
    { path: '[Gmail]/Spam', name: 'Spam', kind: 'spam', delimiter: '/' },
    { path: '[Gmail]/Trash', name: 'Trash', kind: 'trash', delimiter: '/' },
    { path: 'Receipts', name: 'Receipts', kind: 'custom', delimiter: '/' },
    { path: 'Receipts/2026', name: '2026', kind: 'custom', delimiter: '/' }
  ],
  acc_outlook: [
    { path: 'INBOX', name: 'Inbox', kind: 'inbox', delimiter: '/' },
    { path: 'Sent Items', name: 'Sent Items', kind: 'sent', delimiter: '/' },
    { path: 'Drafts', name: 'Drafts', kind: 'drafts', delimiter: '/' },
    { path: 'Archive', name: 'Archive', kind: 'archive', delimiter: '/' },
    { path: 'Junk Email', name: 'Junk Email', kind: 'spam', delimiter: '/' },
    { path: 'Deleted Items', name: 'Deleted Items', kind: 'trash', delimiter: '/' },
    { path: 'Newsletters', name: 'Newsletters', kind: 'custom', delimiter: '/' }
  ],
  acc_space: [
    { path: 'INBOX', name: 'Inbox', kind: 'inbox', delimiter: '.' },
    { path: 'INBOX.Sent', name: 'Sent', kind: 'sent', delimiter: '.' },
    { path: 'INBOX.Drafts', name: 'Drafts', kind: 'drafts', delimiter: '.' },
    { path: 'INBOX.Archive', name: 'Archive', kind: 'archive', delimiter: '.' },
    { path: 'INBOX.Junk', name: 'Junk', kind: 'spam', delimiter: '.' },
    { path: 'INBOX.Trash', name: 'Trash', kind: 'trash', delimiter: '.' },
    { path: 'INBOX.Clients', name: 'Clients', kind: 'custom', delimiter: '.' },
    { path: 'INBOX.Clients.Belleza', name: 'Belleza', kind: 'custom', delimiter: '.' },
    { path: 'INBOX.Clients.Plexon', name: 'Plexon', kind: 'custom', delimiter: '.' },
    { path: 'INBOX.Invoices', name: 'Invoices', kind: 'custom', delimiter: '.' }
  ]
}

const FOLDERS: Folder[] = []
for (const acc of ACCOUNTS) {
  for (const seed of FOLDER_SEEDS[acc.id]) {
    FOLDERS.push({
      id: `fld_${acc.id}_${seed.path.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
      accountId: acc.id,
      path: seed.path,
      name: seed.name,
      delimiter: seed.delimiter,
      kind: seed.kind,
      unreadCount: 0,
      totalCount: 0,
      synced: seed.kind !== 'spam' && seed.kind !== 'trash'
    })
  }
}

function folderOf(accountId: string, kind: FolderKind): Folder {
  return (
    FOLDERS.find((f) => f.accountId === accountId && f.kind === kind) ??
    FOLDERS.find((f) => f.accountId === accountId && f.kind === 'inbox')!
  )
}

// ---------------------------------------------------------------------------
// people + content
// ---------------------------------------------------------------------------
const PEOPLE: EmailAddress[] = [
  { name: 'Aisha Rahman', address: 'aisha.rahman@northgate.io' },
  { name: 'Tom Beckett', address: 'tom@plexongym.com' },
  { name: 'Marta Silva', address: 'marta.silva@belleza-skin.com' },
  { name: 'Dev Patel', address: 'dev.patel@lumencrm.app' },
  { name: 'Chloe Nguyen', address: 'chloe@remwake.io' },
  { name: 'Support', address: 'support@spaceship.com' },
  { name: 'GitHub', address: 'noreply@github.com' },
  { name: 'Stripe', address: 'receipts@stripe.com' },
  { name: 'Ben Ottoline', address: 'ben.ottoline@gmail.com' },
  { name: 'Priya Sharma', address: 'priya@sharma-legal.co.uk' },
  { name: 'Ravi Kumar', address: 'ravi@fotmob-partners.com' },
  { name: 'Linda Cho', address: 'linda.cho@capspace.io' },
  { name: 'The Athletic', address: 'newsletter@theathletic.com' },
  { name: 'Figma', address: 'updates@figma.com' },
  { name: 'Anna Weiss', address: 'anna.weiss@gracie-barra.example' },
  { name: 'Ops Team', address: 'ops@tfc.consulting' },
  { name: 'Nadia Boulos', address: 'nadia@northgate.io' },
  { name: 'Bambu Lab', address: 'no-reply@bambulab.com' }
]

const SUBJECTS = [
  'Q4 roadmap — need your input by Friday',
  'Re: Contract renewal for the Belleza campaign',
  'Plexon launch checklist',
  'Invoice #2291 is ready',
  'Your weekly digest',
  'Follow-up from Tuesday',
  'Quick question about the API rate limits',
  'Design review: hero images v3',
  'Re: Re: shipping dates for the A1 mini spool holder',
  'Security alert: new sign-in',
  'Notes from the client call',
  'Draft press release — please review',
  'Payment received',
  'Sprint 42 retro summary',
  'Can we move Thursday to 3pm?',
  'Onboarding docs for the new analyst',
  'RemWake TestFlight build 41 is live',
  'Re: cap.space newsroom feedback',
  'Renewal quote attached',
  'Heads up: DNS change tonight',
  'Welcome aboard!',
  'Your subscription renews soon',
  'Feedback on the pitch deck',
  'Photos from the offsite',
  'Reminder: timesheets due'
]

const SHORT_BODIES = [
  '<p>Sounds good — let\u2019s lock it in.</p>',
  '<p>Thanks, got it. I\u2019ll come back to you tomorrow morning.</p>',
  '<p>Can you send over the latest numbers when you get a sec?</p>',
  '<p>Approved from my side. Ship it. \u{1F44D}</p>',
  '<p>Moved to 3pm, invite updated.</p>'
]

const LONG_BODY = `
<div style="font-family: Georgia, serif; font-size: 15px; color: #222; max-width: 640px">
  <p>Hi Jamie,</p>
  <p>Thanks for the detailed write-up yesterday — it clarified a lot. I've pulled together the
  points we agreed and a couple of open questions so we don't lose them before Thursday.</p>
  <h3 style="color:#1a4a8a">What we agreed</h3>
  <ol>
    <li>Phase one ships with the unified inbox only; per-account rules land in phase two.</li>
    <li>We keep the existing colour system, but the accent moves one step darker for contrast.</li>
    <li>Reporting stays weekly until the data volume justifies daily rollups.</li>
  </ol>
  <h3 style="color:#1a4a8a">Open questions</h3>
  <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555">
    Who owns the migration script if the vendor slips past the 14th?
  </blockquote>
  <p>My instinct is that we take it in-house and bill the time back, but I'd like your read
  before I put that to the steering group. There's also the question of whether we hold the
  announcement until the pilot cohort has had a full billing cycle.</p>
  <table cellpadding="6" style="border-collapse:collapse;margin:12px 0">
    <tr style="background:#f0f3f8"><th align="left">Workstream</th><th align="left">Owner</th><th align="left">Due</th></tr>
    <tr><td>Data migration</td><td>Nadia</td><td>14 Sep</td></tr>
    <tr><td>Pilot comms</td><td>Jamie</td><td>18 Sep</td></tr>
    <tr><td>Billing switch</td><td>Dev</td><td>1 Oct</td></tr>
  </table>
  <p>Happy to walk through any of it on a call — I'm free most of Wednesday.</p>
  <p>Best,<br>Aisha</p>
</div>`

const NEWSLETTER_BODY = `
<div style="background:#f4f4f6;padding:24px 0;font-family:Helvetica,Arial,sans-serif">
  <table width="600" align="center" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden">
    <tr><td style="background:#111;padding:20px 24px">
      <img src="https://cdn.example.com/newsletter/logo-white.png" width="140" alt="The Athletic" style="display:block">
    </td></tr>
    <tr><td style="padding:24px">
      <img src="https://cdn.example.com/newsletter/hero-2026-09.jpg" width="552" alt="Match report" style="display:block;border-radius:6px">
      <h1 style="font-size:22px;margin:18px 0 8px;color:#111">The week in numbers</h1>
      <p style="color:#444;line-height:1.55;margin:0 0 14px">
        Three teams shifted their expected-goals baseline this week, and one of them did it without
        changing a single starter. Here is what the tracking data actually says.
      </p>
      <a href="https://example.com/story/xg-shifts" style="display:inline-block;background:#e8384f;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:bold">Read the story</a>
      <hr style="border:none;border-top:1px solid #eee;margin:22px 0">
      <p style="color:#777;font-size:12px;margin:0">
        You are receiving this because you subscribed. <a href="https://example.com/unsubscribe" style="color:#777">Unsubscribe</a>.
      </p>
      <img src="https://track.example.com/open.gif?id=abc123" width="1" height="1" alt="">
    </td></tr>
  </table>
</div>`

const PLAIN_BODY = `Hi Jamie,

Quick one before the weekend. The staging box is back up after the DNS change —
you can hit it at https://staging.tfc.consulting again. Logs are in the usual place.

Two things I could not finish:

  * the nightly export still times out at ~40k rows
  * the retry queue needs a dead-letter bucket

> Do you want me to raise a ticket for the export, or is that already tracked?

I'll be around Monday from 9.

Cheers,
Ops
`

const ATTACHMENT_SEEDS = [
  { filename: 'Invoice-2291.pdf', contentType: 'application/pdf', size: 184_320 },
  { filename: 'Q4-roadmap.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 42_112 },
  { filename: 'hero-v3.png', contentType: 'image/png', size: 918_004 },
  { filename: 'contract-draft.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 66_500 },
  { filename: 'offsite-photo.jpg', contentType: 'image/jpeg', size: 2_311_002 },
  { filename: 'notes.txt', contentType: 'text/plain', size: 3_204 }
]

// ---------------------------------------------------------------------------
// message generation
// ---------------------------------------------------------------------------
const MESSAGES: MessageFull[] = []

function makeAttachments(messageId: string, count: number): AttachmentMeta[] {
  const out: AttachmentMeta[] = []
  for (let i = 0; i < count; i++) {
    const seed = ATTACHMENT_SEEDS[Math.floor(rnd() * ATTACHMENT_SEEDS.length)]
    out.push({
      id: uid('att'),
      messageId,
      filename: seed.filename,
      contentType: seed.contentType,
      size: seed.size,
      isInline: false,
      partId: `2.${i + 1}`
    })
  }
  return out
}

function bodyFor(kind: 'short' | 'long' | 'newsletter' | 'plain'): { html?: string; text?: string } {
  switch (kind) {
    case 'newsletter':
      return { html: NEWSLETTER_BODY, text: 'The week in numbers — view this email in a browser.' }
    case 'plain':
      return { text: PLAIN_BODY }
    case 'long':
      return { html: LONG_BODY, text: 'Long message; see HTML part.' }
    default:
      return { html: pick(SHORT_BODIES), text: 'Short message; see HTML part.' }
  }
}

function seedThreads(): void {
  const total = 124
  for (let i = 0; i < total; i++) {
    const account = ACCOUNTS[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2]
    const me: EmailAddress = { name: account.name, address: account.email }
    const other = pick(PEOPLE)
    const third = pick(PEOPLE)
    const threadId = uid('thr')
    const subject = SUBJECTS[i % SUBJECTS.length]

    // Which folder this thread lives in
    let kind: FolderKind = 'inbox'
    if (i % 11 === 3) kind = 'sent'
    else if (i % 13 === 5) kind = 'archive'
    else if (i % 29 === 7) kind = 'drafts'
    else if (i % 37 === 11) kind = 'spam'
    const folder = folderOf(account.id, kind)

    const msgCount = chance(0.35) ? 2 + Math.floor(rnd() * 3) : 1
    const baseDate = NOW - Math.floor(rnd() * 26 * 864e5) - i * 36e5

    const bodyKind: 'short' | 'long' | 'newsletter' | 'plain' =
      other.address.includes('newsletter') || other.address.includes('updates')
        ? 'newsletter'
        : i % 17 === 4
          ? 'plain'
          : i % 5 === 0
            ? 'long'
            : 'short'

    const unreadThread = kind === 'inbox' && chance(0.28)
    const starredThread = chance(0.12)

    for (let m = 0; m < msgCount; m++) {
      const outgoing = kind === 'sent' || kind === 'drafts' || (m > 0 && m % 2 === 1)
      const from = outgoing ? me : other
      const to = outgoing ? [other] : [me]
      const cc = msgCount > 2 && m === msgCount - 1 ? [third] : []
      const id = uid('msg')
      const isLast = m === msgCount - 1
      const attachmentCount = chance(0.18) ? 1 + Math.floor(rnd() * 2) : 0
      const body = bodyFor(m === 0 ? bodyKind : 'short')
      MESSAGES.push({
        id,
        accountId: account.id,
        folderId: folder.id,
        threadId,
        uid: 1000 + i * 10 + m,
        messageIdHeader: `${id}@estuary.local`,
        subject: m === 0 ? subject : `Re: ${subject}`,
        from: [from],
        to,
        cc,
        bcc: [],
        replyTo: [],
        date: baseDate + m * 45 * 60_000,
        snippet:
          (body.html ?? body.text ?? '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160) || 'No preview available',
        flags: {
          seen: !(unreadThread && isLast),
          flagged: starredThread && isLast,
          answered: !isLast,
          draft: kind === 'drafts',
          forwarded: false
        },
        hasAttachments: attachmentCount > 0,
        size: 2400 + Math.floor(rnd() * 90_000),
        labels: account.provider === 'gmail' ? ['\\Inbox'] : [],
        bodyFetched: true,
        html: body.html,
        text: body.text,
        references: [],
        attachments: makeAttachments(id, attachmentCount),
        headers: {
          'message-id': `<${id}@estuary.local>`,
          from: from.name ? `${from.name} <${from.address}>` : from.address,
          subject,
          date: new Date(baseDate + m * 45 * 60_000).toUTCString(),
          ...(bodyKind === 'newsletter'
            ? { 'list-unsubscribe': '<https://example.com/unsubscribe>' }
            : {})
        }
      })
    }
  }
}

seedThreads()

// ---------------------------------------------------------------------------
// derived views
// ---------------------------------------------------------------------------
function threadFor(threadId: string): ThreadSummary | null {
  const msgs = MESSAGES.filter((m) => m.threadId === threadId).sort((a, b) => a.date - b.date)
  if (msgs.length === 0) return null
  const last = msgs[msgs.length - 1]
  const participants: EmailAddress[] = []
  const seen = new Set<string>()
  for (const m of msgs) {
    for (const a of [...m.from, ...m.to]) {
      const k = a.address.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        participants.push(a)
      }
    }
  }
  const kinds = new Set<FolderKind>()
  for (const m of msgs) {
    const f = FOLDERS.find((x) => x.id === m.folderId)
    if (f) kinds.add(f.kind)
  }
  return {
    id: threadId,
    accountId: last.accountId,
    subject: msgs[0].subject.replace(/^re:\s*/i, ''),
    participants,
    lastDate: last.date,
    messageCount: msgs.length,
    unreadCount: msgs.filter((m) => !m.flags.seen).length,
    hasStarred: msgs.some((m) => m.flags.flagged),
    hasAttachments: msgs.some((m) => m.hasAttachments),
    snippet: last.snippet,
    folderKinds: Array.from(kinds),
    messageIds: msgs.map((m) => m.id),
    hasDraft: msgs.some((m) => m.flags.draft)
  }
}

function allThreads(): ThreadSummary[] {
  const ids = Array.from(new Set(MESSAGES.map((m) => m.threadId)))
  return ids
    .map(threadFor)
    .filter((t): t is ThreadSummary => t !== null)
    .sort((a, b) => b.lastDate - a.lastDate)
}

function matchesQuery(t: ThreadSummary, q: MessageListQuery): boolean {
  const msgs = MESSAGES.filter((m) => t.messageIds.includes(m.id))
  if (q.accountId && t.accountId !== q.accountId) return false
  if (q.folderId) {
    if (!msgs.some((m) => m.folderId === q.folderId)) return false
  } else if (q.folderKind) {
    const ok = msgs.some((m) => FOLDERS.find((f) => f.id === m.folderId)?.kind === q.folderKind)
    if (!ok) return false
  } else {
    // unified default: hide spam + trash
    const hidden = msgs.every((m) => {
      const k = FOLDERS.find((f) => f.id === m.folderId)?.kind
      return k === 'spam' || k === 'trash'
    })
    if (hidden) return false
  }
  if (q.unreadOnly && t.unreadCount === 0) return false
  if (q.starredOnly && !t.hasStarred) return false
  if (q.withAttachments && !t.hasAttachments) return false
  return true
}

function paginate(threads: ThreadSummary[], limit = 50, cursor?: string): MessageListResult {
  const offset = cursor ? Number(cursor) || 0 : 0
  const page = threads.slice(offset, offset + limit)
  const next = offset + limit < threads.length ? String(offset + limit) : undefined
  return { threads: page, nextCursor: next, total: threads.length }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
interface ParsedSearch {
  text: string[]
  from?: string
  to?: string
  subject?: string
  hasAttachment?: boolean
  isUnread?: boolean
  isStarred?: boolean
  before?: number
  after?: number
}

function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: [] }
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const [rawKey, ...rest] = tok.split(':')
    const value = rest.join(':')
    const key = rawKey.toLowerCase()
    if (!value) {
      out.text.push(tok.toLowerCase())
      continue
    }
    switch (key) {
      case 'from':
        out.from = value.toLowerCase()
        break
      case 'to':
        out.to = value.toLowerCase()
        break
      case 'subject':
        out.subject = value.toLowerCase()
        break
      case 'has':
        if (value.toLowerCase() === 'attachment') out.hasAttachment = true
        break
      case 'is':
        if (value.toLowerCase() === 'unread') out.isUnread = true
        if (value.toLowerCase() === 'starred') out.isStarred = true
        break
      case 'before':
        out.before = Date.parse(value)
        break
      case 'after':
        out.after = Date.parse(value)
        break
      default:
        out.text.push(tok.toLowerCase())
    }
  }
  return out
}

function searchThreads(q: string, accountId?: string): ThreadSummary[] {
  const p = parseSearch(q)
  return allThreads().filter((t) => {
    if (accountId && t.accountId !== accountId) return false
    if (p.hasAttachment && !t.hasAttachments) return false
    if (p.isUnread && t.unreadCount === 0) return false
    if (p.isStarred && !t.hasStarred) return false
    if (p.before && t.lastDate >= p.before) return false
    if (p.after && t.lastDate <= p.after) return false
    if (p.subject && !t.subject.toLowerCase().includes(p.subject)) return false
    const msgs = MESSAGES.filter((m) => t.messageIds.includes(m.id))
    if (p.from && !msgs.some((m) => m.from.some((a) => `${a.name ?? ''} ${a.address}`.toLowerCase().includes(p.from!))))
      return false
    if (p.to && !msgs.some((m) => m.to.some((a) => `${a.name ?? ''} ${a.address}`.toLowerCase().includes(p.to!))))
      return false
    if (p.text.length > 0) {
      const hay = `${t.subject} ${t.snippet} ${t.participants.map((x) => `${x.name ?? ''} ${x.address}`).join(' ')}`.toLowerCase()
      if (!p.text.every((w) => hay.includes(w))) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// mutable app state
// ---------------------------------------------------------------------------
let settings: AppSettings = { ...DEFAULT_SETTINGS, theme: 'system' }
const drafts: Draft[] = []
const syncStatuses: SyncStatus[] = ACCOUNTS.map((a, i) => ({
  accountId: a.id,
  state: i === 1 ? 'syncing' : 'listening',
  detail: i === 1 ? 'Syncing INBOX 240/1200' : 'Idle',
  lastSyncAt: a.lastSyncAt,
  progress: i === 1 ? 0.2 : undefined
}))

const PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    authTypes: ['oauth2'],
    oauthProvider: 'google',
    cacheLimit: 5000
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    authTypes: ['oauth2'],
    oauthProvider: 'microsoft',
    cacheLimit: 5000
  },
  {
    id: 'spacemail',
    label: 'Spacemail (Spaceship)',
    domains: [],
    imap: { host: 'mail.spacemail.com', port: 993, secure: true },
    smtp: { host: 'mail.spacemail.com', port: 465, secure: true },
    authTypes: ['password'],
    help: 'Use your full email address and mailbox password.',
    cacheLimit: 5000
  },
  {
    id: 'imap',
    label: 'Other (IMAP)',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    authTypes: ['password'],
    cacheLimit: 2000
  }
]

function unreadCounts(): UnreadCounts {
  const byAccount: Record<string, number> = {}
  const byFolder: Record<string, number> = {}
  let inbox = 0
  for (const m of MESSAGES) {
    if (m.flags.seen) continue
    const folder = FOLDERS.find((f) => f.id === m.folderId)
    if (!folder) continue
    byFolder[folder.id] = (byFolder[folder.id] ?? 0) + 1
    if (folder.kind === 'inbox') {
      byAccount[m.accountId] = (byAccount[m.accountId] ?? 0) + 1
      inbox++
    }
  }
  for (const f of FOLDERS) {
    f.unreadCount = byFolder[f.id] ?? 0
    f.totalCount = MESSAGES.filter((m) => m.folderId === f.id).length
  }
  return { inbox, byAccount, byFolder }
}
unreadCounts()

// ---------------------------------------------------------------------------
// the api
// ---------------------------------------------------------------------------
export function createMockApi(): RendererApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  function emit<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) fn(payload as unknown)
  }

  function mailChanged(accountId = ACCOUNTS[0].id, reason: 'sync' | 'action' | 'send' | 'delete' = 'action'): void {
    emit('mail:changed', { accountId, reason })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: { [C in IpcChannel]: (req: IpcReq<C>) => Promise<IpcRes<C>> | IpcRes<C> } = {
    'accounts:list': () => ACCOUNTS,
    'accounts:add': (req) => {
      const account: Account = {
        id: uid('acc'),
        email: req.email,
        name: req.name,
        provider: req.provider,
        authType: req.authType,
        imap: req.imap,
        smtp: req.smtp,
        username: req.username,
        color: req.color ?? '#7e22ce',
        signature: req.signature,
        createdAt: Date.now(),
        cacheLimit: req.cacheLimit ?? 5000,
        enabled: true
      }
      ACCOUNTS.push(account)
      FOLDERS.push({
        id: `fld_${account.id}_inbox`,
        accountId: account.id,
        path: 'INBOX',
        name: 'Inbox',
        delimiter: '/',
        kind: 'inbox',
        unreadCount: 0,
        totalCount: 0,
        synced: true
      })
      emit('accounts:changed', { accounts: ACCOUNTS })
      return account
    },
    'accounts:update': (req) => {
      const acc = ACCOUNTS.find((a) => a.id === req.id)
      if (!acc) throw new Error('Account not found')
      Object.assign(acc, req.patch)
      emit('accounts:changed', { accounts: ACCOUNTS })
      return acc
    },
    'accounts:remove': (req) => {
      const i = ACCOUNTS.findIndex((a) => a.id === req.id)
      if (i >= 0) ACCOUNTS.splice(i, 1)
      emit('accounts:changed', { accounts: ACCOUNTS })
    },
    'accounts:test': async () => {
      await delay(600)
      return { ok: true, imap: { ok: true, capabilities: ['IMAP4rev1', 'IDLE', 'CONDSTORE'] }, smtp: { ok: true } }
    },
    'accounts:presets': () => PRESETS,
    'accounts:autodetect': (req) => {
      const domain = req.email.split('@')[1]?.toLowerCase() ?? ''
      const preset = PRESETS.find((p) => p.domains.includes(domain))
      if (!preset) return null
      return { imap: preset.imap, smtp: preset.smtp, provider: preset.id }
    },
    'accounts:reauth': async () => {
      await delay(500)
      return { ok: true }
    },

    'auth:oauthStart': async (req) => {
      emit('oauth:progress', { step: 'waitingForBrowser' })
      await delay(900)
      emit('oauth:progress', { step: 'exchanging' })
      await delay(500)
      emit('oauth:progress', { step: 'done' })
      return {
        ok: true,
        email: req.email ?? 'new.user@example.com',
        tokens: {
          provider: req.provider,
          clientId: req.clientId,
          clientSecret: req.clientSecret,
          accessToken: 'mock-access',
          refreshToken: 'mock-refresh',
          expiresAt: Date.now() + 3600_000,
          scope: 'mock',
          email: req.email ?? 'new.user@example.com'
        }
      }
    },
    'auth:oauthCancel': () => undefined,

    'folders:list': (req) => (req.accountId ? FOLDERS.filter((f) => f.accountId === req.accountId) : FOLDERS),
    'folders:create': (req) => {
      const folder: Folder = {
        id: uid('fld'),
        accountId: req.accountId,
        path: req.parentPath ? `${req.parentPath}/${req.name}` : req.name,
        name: req.name,
        delimiter: '/',
        kind: 'custom',
        unreadCount: 0,
        totalCount: 0,
        synced: true
      }
      FOLDERS.push(folder)
      emit('folders:changed', { accountId: req.accountId })
      return folder
    },
    'folders:unreadCounts': () => unreadCounts(),

    'messages:list': async (req) => {
      await delay(120)
      const threads = allThreads().filter((t) => matchesQuery(t, req))
      return paginate(threads, req.limit ?? 50, req.cursor)
    },
    'messages:get': async (req) => {
      await delay(60)
      const m = MESSAGES.find((x) => x.id === req.messageId)
      if (!m) throw new Error('Message not found')
      return m
    },
    'messages:thread': async (req) => {
      await delay(90)
      return MESSAGES.filter((m) => m.threadId === req.threadId).sort((a, b) => a.date - b.date)
    },
    'messages:threadSummary': (req) => threadFor(req.threadId),
    'messages:action': async (req) => {
      await delay(60)
      const targets = MESSAGES.filter((m) => req.messageIds.includes(m.id))
      const accountIds = new Set(targets.map((m) => m.accountId))
      for (const m of targets) {
        switch (req.action) {
          case 'markRead':
            m.flags.seen = true
            break
          case 'markUnread':
            m.flags.seen = false
            break
          case 'star':
            m.flags.flagged = true
            break
          case 'unstar':
            m.flags.flagged = false
            break
          case 'archive':
            m.folderId = folderOf(m.accountId, 'archive').id
            break
          case 'trash':
            m.folderId = folderOf(m.accountId, 'trash').id
            break
          case 'spam':
            m.folderId = folderOf(m.accountId, 'spam').id
            break
          case 'notSpam':
            m.folderId = folderOf(m.accountId, 'inbox').id
            break
          case 'move':
            if (req.targetFolderId) m.folderId = req.targetFolderId
            break
          case 'deletePermanently': {
            const i = MESSAGES.indexOf(m)
            if (i >= 0) MESSAGES.splice(i, 1)
            break
          }
        }
      }
      unreadCounts()
      for (const id of accountIds) mailChanged(id, req.action === 'deletePermanently' ? 'delete' : 'action')
    },
    'messages:raw': async (req) => {
      const m = MESSAGES.find((x) => x.id === req.messageId)
      if (!m) throw new Error('Message not found')
      const headers = Object.entries(m.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      return `${headers}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${m.html ?? m.text ?? ''}`
    },

    'attachments:download': async (req) => {
      await delay(300)
      const att = MESSAGES.flatMap((m) => m.attachments).find((a) => a.id === req.attachmentId)
      if (!att) throw new Error('Attachment not found')
      att.localPath = `C:/Users/mock/Downloads/${att.filename}`
      return att
    },
    'attachments:saveAs': async (req) => {
      await delay(300)
      const att = MESSAGES.flatMap((m) => m.attachments).find((a) => a.id === req.attachmentId)
      return { saved: true, path: `C:/Users/mock/Downloads/${att?.filename ?? 'file'}` }
    },
    'attachments:open': async () => {
      await delay(150)
    },
    'attachments:inlineDataUrl': async () => {
      // 1x1 transparent gif
      return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    },

    'search:query': async (req) => {
      await delay(140)
      return paginate(searchThreads(req.q, req.accountId), req.limit ?? 50, req.cursor)
    },

    'compose:send': async () => {
      await delay(700)
      mailChanged(ACCOUNTS[0].id, 'send')
      return { ok: true }
    },
    'drafts:save': (req: ComposePayload) => {
      const existing = req.draftId ? drafts.find((d) => d.id === req.draftId) : undefined
      if (existing) {
        existing.payload = req
        existing.updatedAt = Date.now()
        return existing
      }
      const draft: Draft = { id: uid('drf'), accountId: req.accountId, payload: req, updatedAt: Date.now() }
      drafts.push(draft)
      return draft
    },
    'drafts:list': (req) => (req.accountId ? drafts.filter((d) => d.accountId === req.accountId) : drafts),
    'drafts:get': (req) => drafts.find((d) => d.id === req.draftId) ?? null,
    'drafts:delete': (req) => {
      const i = drafts.findIndex((d) => d.id === req.draftId)
      if (i >= 0) drafts.splice(i, 1)
    },
    'compose:open': (req) => {
      console.info('[mock] compose:open', req)
    },
    'compose:init': () => {
      const payload: ComposePayload = {
        accountId: ACCOUNTS[0].id,
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        html: '',
        attachments: [],
        mode: 'new'
      }
      return { payload, accounts: ACCOUNTS }
    },
    'compose:pickFiles': async () => {
      await delay(250)
      return [
        { path: 'C:/Users/mock/Documents/report.pdf', filename: 'report.pdf', size: 152_000, contentType: 'application/pdf' }
      ]
    },

    'sync:now': async (req) => {
      const targets = req.accountId ? [req.accountId] : ACCOUNTS.map((a) => a.id)
      for (const id of targets) {
        const st = syncStatuses.find((s) => s.accountId === id)
        if (!st) continue
        st.state = 'syncing'
        st.detail = 'Checking for new mail'
        emit('sync:status', { ...st })
      }
      await delay(900)
      for (const id of targets) {
        const st = syncStatuses.find((s) => s.accountId === id)
        if (!st) continue
        st.state = 'listening'
        st.detail = 'Idle'
        st.lastSyncAt = Date.now()
        st.progress = undefined
        emit('sync:status', { ...st })
      }
      mailChanged(targets[0], 'sync')
    },
    'sync:status': () => syncStatuses,

    'settings:get': () => settings,
    'settings:set': (patch) => {
      settings = { ...settings, ...patch }
      emit('settings:changed', settings)
      return settings
    },
    'app:openExternal': (req) => {
      window.open(req.url, '_blank', 'noopener')
    },
    'app:showItemInFolder': () => undefined,
    'app:version': () => ({ version: '0.1.0-mock', electron: 'browser', platform: 'win32' }),
    'update:check': () => null,
    'update:install': () => ({ ok: false, error: 'Updates are not available in the browser mock.' }),
    'app:pickDirectory': async () => {
      await delay(200)
      return 'C:/Users/mock/Downloads'
    },
    'contacts:suggest': (req) => {
      const q = req.q.toLowerCase()
      return PEOPLE.filter((p) => `${p.name ?? ''} ${p.address}`.toLowerCase().includes(q))
        .slice(0, req.limit ?? 8)
        .map((p) => ({ name: p.name, address: p.address, count: 1 + Math.floor(rnd() * 20) }))
    }
  }

  return {
    async invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>> {
      const handler = handlers[channel]
      if (!handler) throw new Error(`[mock] unknown channel ${channel}`)
      return (await handler(req)) as IpcRes<C>
    },
    on<E extends IpcEvent>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void {
      const set = listeners.get(event) ?? new Set()
      set.add(handler as (payload: unknown) => void)
      listeners.set(event, set)
      return () => {
        set.delete(handler as (payload: unknown) => void)
      }
    },
    windowKind: typeof location !== 'undefined' && location.pathname.includes('compose') ? 'compose' : 'main',
    platform: 'win32'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
