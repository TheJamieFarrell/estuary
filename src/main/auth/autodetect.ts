/**
 * Work out IMAP/SMTP settings from nothing but an email address.
 *
 * Order (first hit wins):
 *   1. Built-in preset by domain            - instant, no network
 *   2. Mozilla ISPDB (autoconfig.thunderbird.net)
 *   3. Provider-hosted autoconfig           - autoconfig.<domain> and <domain>/.well-known
 *   4. DNS SRV records, RFC 6186
 *   5. MX heuristics                        - Google Workspace / Microsoft 365 / Spacemail
 *   6. Guessed hostnames, but only ones that actually answer a TLS handshake
 *
 * Nothing in here throws: every step is wrapped, and the function returns null when it
 * has learned nothing useful. Network calls are capped by AbortController.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import type { ServerSettings } from '@shared/types'
import { domainOf, presetById, presetForEmail } from './presets'

export interface AutodetectResult {
  imap?: ServerSettings
  smtp?: ServerSettings
  /** ProviderId when a preset matched, otherwise a free-form source/provider label. */
  provider?: string
}

/** Injection points so the whole pipeline is unit-testable without a network. */
export interface AutodetectDeps {
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>
  resolveSrv?: (
    name: string
  ) => Promise<{ name: string; port: number; priority: number; weight: number }[]>
  /** Returns the body, or null for any failure (non-2xx, timeout, DNS, TLS...). */
  fetchText?: (url: string, timeoutMs: number) => Promise<string | null>
  /** True when a TLS handshake to host:port completes. */
  probeTls?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** True when a plain TCP connection to host:port is accepted (for STARTTLS ports). */
  probeTcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
}

const HTTP_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 4000

// ---------------------------------------------------------------------------
// Default (real) implementations
// ---------------------------------------------------------------------------

async function defaultFetchText(url: string, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: 'application/xml, text/xml, */*' }
    })
    if (!res.ok) return null
    const text = await res.text()
    return text && text.length < 512_000 ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function defaultResolveMx(domain: string): Promise<{ exchange: string; priority: number }[]> {
  return await dns.resolveMx(domain)
}

async function defaultResolveSrv(
  name: string
): Promise<{ name: string; port: number; priority: number; weight: number }[]> {
  return await dns.resolveSrv(name)
}

function defaultProbeTls(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false },
      () => finish(true)
    )
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    setTimeout(() => finish(false), timeoutMs + 250).unref?.()
  })
}

function defaultProbeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const socket = net.connect({ host, port, timeout: timeoutMs }, () => finish(true))
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    setTimeout(() => finish(false), timeoutMs + 250).unref?.()
  })
}

function withDefaults(deps: AutodetectDeps): Required<AutodetectDeps> {
  return {
    resolveMx: deps.resolveMx ?? defaultResolveMx,
    resolveSrv: deps.resolveSrv ?? defaultResolveSrv,
    fetchText: deps.fetchText ?? defaultFetchText,
    probeTls: deps.probeTls ?? defaultProbeTls,
    probeTcp: deps.probeTcp ?? defaultProbeTcp
  }
}

// ---------------------------------------------------------------------------
// Autoconfig XML (Mozilla clientConfig format, v1.1)
// ---------------------------------------------------------------------------

type SocketType = 'SSL' | 'STARTTLS' | 'plain'

interface ParsedServer {
  hostname: string
  port: number
  socketType: SocketType
  username?: string
}

export interface ParsedAutoconfig {
  imap?: ParsedServer
  smtp?: ParsedServer
  /** `id` attribute or <displayName> of <emailProvider> */
  provider?: string
}

const SOCKET_RANK: Record<SocketType, number> = { SSL: 0, STARTTLS: 1, plain: 2 }

function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  if (!m) return undefined
  const raw = m[1]
  if (raw === undefined) return undefined
  return decodeEntities(raw.trim())
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function normaliseSocketType(raw: string | undefined): SocketType {
  const v = (raw ?? '').trim().toUpperCase()
  if (v === 'SSL' || v === 'TLS') return 'SSL'
  if (v === 'STARTTLS') return 'STARTTLS'
  return 'plain'
}

/** Expand the placeholders the Mozilla format allows in hostname/username. */
export function expandPlaceholders(value: string, email: string): string {
  const at = email.lastIndexOf('@')
  const local = at > 0 ? email.slice(0, at) : email
  const domain = at > 0 ? email.slice(at + 1) : ''
  return value
    .replace(/%EMAILADDRESS%/gi, email)
    .replace(/%EMAILLOCALPART%/gi, local)
    .replace(/%EMAILDOMAIN%/gi, domain)
}

/**
 * Parse a Mozilla autoconfig / ISPDB `clientConfig` document. Deliberately regex based:
 * there is no DOM in the main process and the format is small and well-behaved.
 * Picks the best IMAP and SMTP entries, preferring SSL, then STARTTLS, then plain.
 */
export function parseAutoconfig(xml: string, email = ''): ParsedAutoconfig | null {
  if (!xml || !/<clientConfig|<emailProvider/i.test(xml)) return null

  const out: ParsedAutoconfig = {}

  const providerAttr = /<emailProvider[^>]*\bid\s*=\s*["']([^"']+)["']/i.exec(xml)
  out.provider = providerAttr?.[1] ?? tagText(xml, 'displayShortName') ?? tagText(xml, 'displayName')

  const blockRe = /<(incomingServer|outgoingServer)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  let bestImap: ParsedServer | undefined
  let bestSmtp: ParsedServer | undefined

  while ((m = blockRe.exec(xml)) !== null) {
    const kind = (m[1] ?? '').toLowerCase()
    const attrs = m[2] ?? ''
    const body = m[3] ?? ''
    const type = (/type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '').toLowerCase()

    if (kind === 'incomingserver' && type !== 'imap') continue
    if (kind === 'outgoingserver' && type !== 'smtp') continue

    const hostnameRaw = tagText(body, 'hostname')
    const portRaw = tagText(body, 'port')
    if (!hostnameRaw || !portRaw) continue
    const port = Number.parseInt(portRaw, 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue

    const server: ParsedServer = {
      hostname: expandPlaceholders(hostnameRaw, email),
      port,
      socketType: normaliseSocketType(tagText(body, 'socketType')),
      username: (() => {
        const u = tagText(body, 'username')
        return u ? expandPlaceholders(u, email) : undefined
      })()
    }

    if (kind === 'incomingserver') {
      if (!bestImap || SOCKET_RANK[server.socketType] < SOCKET_RANK[bestImap.socketType]) {
        bestImap = server
      }
    } else if (!bestSmtp || SOCKET_RANK[server.socketType] < SOCKET_RANK[bestSmtp.socketType]) {
      bestSmtp = server
    }
  }

  if (bestImap) out.imap = bestImap
  if (bestSmtp) out.smtp = bestSmtp
  if (!out.imap && !out.smtp) return null
  return out
}

function toServerSettings(s: ParsedServer): ServerSettings {
  return { host: s.hostname, port: s.port, secure: s.socketType === 'SSL' }
}

// ---------------------------------------------------------------------------
// MX heuristics
// ---------------------------------------------------------------------------

const GMAIL_SERVERS: AutodetectResult = {
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  provider: 'gmail'
}

const M365_SERVERS: AutodetectResult = {
  imap: { host: 'outlook.office365.com', port: 993, secure: true },
  smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  provider: 'outlook'
}

/**
 * Map MX hostnames onto a known provider. Exported for tests and because the account
 * wizard shows "Looks like Google Workspace" style hints.
 */
export function providerFromMx(exchanges: string[]): AutodetectResult | null {
  const hosts = exchanges.map((e) => e.toLowerCase().replace(/\.+$/, ''))
  const any = (needle: string) => hosts.some((h) => h.includes(needle))

  // Google Workspace: aspmx.l.google.com, alt1.aspmx.l.google.com, *.googlemail.com
  if (any('google.com') || any('googlemail.com')) return { ...GMAIL_SERVERS }
  // Microsoft 365: contoso-com.mail.protection.outlook.com
  if (any('protection.outlook.com') || any('outlook.com') || any('office365.com')) {
    return { ...M365_SERVERS }
  }
  // Spacemail (Spaceship): mx1.spacemail.com / mx2.spacemail.com
  if (any('spacemail') || any('spaceship')) {
    const preset = presetById('spacemail')
    if (preset) return { imap: { ...preset.imap }, smtp: { ...preset.smtp }, provider: 'spacemail' }
  }
  // Fastmail hosts customer domains on messagingengine.com
  if (any('messagingengine.com') || any('fastmail.com')) {
    const preset = presetById('fastmail')
    if (preset) return { imap: { ...preset.imap }, smtp: { ...preset.smtp }, provider: 'fastmail' }
  }
  // iCloud custom domains
  if (any('icloud.com') || any('apple.com')) {
    const preset = presetById('icloud')
    if (preset) return { imap: { ...preset.imap }, smtp: { ...preset.smtp }, provider: 'icloud' }
  }
  return null
}

// ---------------------------------------------------------------------------
// DNS SRV, RFC 6186
// ---------------------------------------------------------------------------

interface SrvSpec {
  service: string
  secure: boolean
  kind: 'imap' | 'smtp'
}

const SRV_SPECS: SrvSpec[] = [
  { service: '_imaps._tcp', secure: true, kind: 'imap' },
  { service: '_imap._tcp', secure: false, kind: 'imap' },
  { service: '_submissions._tcp', secure: true, kind: 'smtp' },
  { service: '_submission._tcp', secure: false, kind: 'smtp' }
]

async function srvLookup(
  domain: string,
  deps: Required<AutodetectDeps>
): Promise<AutodetectResult | null> {
  const out: AutodetectResult = {}
  for (const spec of SRV_SPECS) {
    if (out[spec.kind]) continue
    let records: { name: string; port: number; priority: number; weight: number }[]
    try {
      records = await deps.resolveSrv(`${spec.service}.${domain}`)
    } catch {
      continue
    }
    if (!Array.isArray(records) || records.length === 0) continue
    // RFC 6186/2782: a single record with target "." means the service is not offered.
    const usable = records
      .filter((r) => r && r.name && r.name !== '.' && r.port > 0)
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    const best = usable[0]
    if (!best) continue
    out[spec.kind] = {
      host: best.name.replace(/\.+$/, ''),
      port: best.port,
      secure: spec.secure
    }
  }
  if (!out.imap && !out.smtp) return null
  out.provider = 'srv'
  return out
}

// ---------------------------------------------------------------------------
// Guessing (probed)
// ---------------------------------------------------------------------------

async function guessProbed(
  domain: string,
  deps: Required<AutodetectDeps>
): Promise<AutodetectResult | null> {
  const imapHosts = [`imap.${domain}`, `mail.${domain}`, domain]
  const smtpHosts = [`smtp.${domain}`, `mail.${domain}`, domain]

  let imap: ServerSettings | undefined
  for (const host of imapHosts) {
    if (await deps.probeTls(host, 993, PROBE_TIMEOUT_MS)) {
      imap = { host, port: 993, secure: true }
      break
    }
  }

  let smtp: ServerSettings | undefined
  for (const host of smtpHosts) {
    if (await deps.probeTls(host, 465, PROBE_TIMEOUT_MS)) {
      smtp = { host, port: 465, secure: true }
      break
    }
  }
  if (!smtp) {
    // 465 is implicit TLS; 587 is STARTTLS so it only answers a plain TCP connect.
    for (const host of smtpHosts) {
      if (await deps.probeTcp(host, 587, PROBE_TIMEOUT_MS)) {
        smtp = { host, port: 587, secure: false }
        break
      }
    }
  }

  if (!imap && !smtp) return null
  return { imap, smtp, provider: 'guess' }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function autodetect(
  email: string,
  deps: AutodetectDeps = {}
): Promise<AutodetectResult | null> {
  const d = withDefaults(deps)
  const domain = domainOf(email)
  if (!domain) return null
  const address = String(email).trim()

  // 1. Preset by domain.
  try {
    const preset = presetForEmail(address)
    if (preset && preset.id !== 'imap') {
      return { imap: { ...preset.imap }, smtp: { ...preset.smtp }, provider: preset.id }
    }
  } catch {
    /* keep going */
  }

  // 2. Mozilla ISPDB.
  const ispdb = await tryAutoconfigUrl(
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
    address,
    d
  )
  if (ispdb) return ispdb

  // 3. Provider-hosted autoconfig.
  const q = encodeURIComponent(address)
  const hosted = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${q}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${q}`
  ]
  for (const url of hosted) {
    const hit = await tryAutoconfigUrl(url, address, d)
    if (hit) return hit
  }

  // 4. DNS SRV.
  try {
    const srv = await srvLookup(domain, d)
    if (srv) return srv
  } catch {
    /* keep going */
  }

  // 5. MX heuristics.
  try {
    const mx = await d.resolveMx(domain)
    const hit = providerFromMx((mx ?? []).map((r) => r.exchange))
    if (hit) return hit
  } catch {
    /* keep going */
  }

  // 6. Probed guesses.
  try {
    const guess = await guessProbed(domain, d)
    if (guess) return guess
  } catch {
    /* keep going */
  }

  return null
}

async function tryAutoconfigUrl(
  url: string,
  email: string,
  d: Required<AutodetectDeps>
): Promise<AutodetectResult | null> {
  try {
    const xml = await d.fetchText(url, HTTP_TIMEOUT_MS)
    if (!xml) return null
    const parsed = parseAutoconfig(xml, email)
    if (!parsed || (!parsed.imap && !parsed.smtp)) return null
    return {
      imap: parsed.imap ? toServerSettings(parsed.imap) : undefined,
      smtp: parsed.smtp ? toServerSettings(parsed.smtp) : undefined,
      provider: parsed.provider
    }
  } catch {
    return null
  }
}
