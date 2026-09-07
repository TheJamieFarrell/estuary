/**
 * Built-in provider presets.
 *
 * These fill in the account wizard the moment the user types an address we recognise.
 * Anything not covered here goes through `autodetect()` (ISPDB / autoconfig / SRV / MX)
 * and finally falls back to the generic `imap` preset with empty servers.
 *
 * Server details verified September 2026 against each provider's own help centre.
 */
import type { ProviderId, ProviderPreset, ServerSettings } from '@shared/types'

/** Implicit TLS (993 / 465). */
const tls = (host: string, port: number): ServerSettings => ({ host, port, secure: true })
/** STARTTLS or plain (143 / 587). */
const starttls = (host: string, port: number): ServerSettings => ({ host, port, secure: false })

export const PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: tls('imap.gmail.com', 993),
    smtp: tls('smtp.gmail.com', 465),
    authTypes: ['oauth2', 'password'],
    oauthProvider: 'google',
    help:
      'Sign in with Google is the recommended option. To use a password instead you need an ' +
      'app password: turn on 2-Step Verification on your Google Account first, then create a ' +
      '16-character app password and paste it here - your normal Google password will not work. ' +
      'IMAP no longer has to be enabled manually in Gmail settings.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    cacheLimit: 5000
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: tls('outlook.office365.com', 993),
    smtp: starttls('smtp.office365.com', 587),
    // OAuth only: Microsoft turned off basic (password) auth for IMAP and SMTP on
    // personal Outlook.com accounts, and app passwords no longer work for mail either.
    authTypes: ['oauth2'],
    oauthProvider: 'microsoft',
    help:
      'Microsoft has disabled password (basic) authentication for IMAP and SMTP on personal ' +
      'Outlook.com, Hotmail and Live accounts, so Estuary has to sign you in with Microsoft. ' +
      'Work or school accounts also need OAuth unless your admin has re-enabled basic auth.',
    helpUrl: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353',
    cacheLimit: 5000
  },
  {
    id: 'spacemail',
    label: 'Spacemail (Spaceship)',
    // Spacemail is custom-domain mail, so there is no fixed domain list. It is chosen
    // manually in the wizard, or detected by autodetect() when the domain's MX records
    // point at Spacemail / Spaceship.
    domains: [],
    imap: tls('mail.spacemail.com', 993),
    smtp: tls('mail.spacemail.com', 465),
    authTypes: ['password'],
    help:
      'Use your full Spacemail address as the username and the mailbox password you use for ' +
      'Spacemail webmail (not your Spaceship account password). Mailbox passwords are set in ' +
      'Spaceship under Mailboxes.',
    helpUrl: 'https://www.spaceship.com/knowledgebase/connect-spacemail-to-email-client/',
    cacheLimit: 5000
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: tls('imap.mail.me.com', 993),
    smtp: starttls('smtp.mail.me.com', 587),
    authTypes: ['password'],
    help:
      'iCloud requires an app-specific password. Sign in at account.apple.com, go to ' +
      'Sign-In and Security > App-Specific Passwords, generate one for Estuary and paste it ' +
      'here. Two-factor authentication must be on. The username is your full iCloud address.',
    helpUrl: 'https://support.apple.com/en-us/102654',
    cacheLimit: 5000
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: [
      'yahoo.com',
      'yahoo.co.uk',
      'yahoo.co.jp',
      'yahoo.ca',
      'yahoo.com.au',
      'yahoo.com.br',
      'yahoo.co.in',
      'yahoo.de',
      'yahoo.fr',
      'yahoo.es',
      'yahoo.it',
      'ymail.com',
      'rocketmail.com'
    ],
    imap: tls('imap.mail.yahoo.com', 993),
    smtp: tls('smtp.mail.yahoo.com', 465),
    authTypes: ['password'],
    help:
      'Yahoo requires an app password. Go to your Yahoo Account Security page, choose ' +
      '"Generate and manage app passwords", create one for Estuary and paste it here. Your ' +
      'normal Yahoo password will be rejected.',
    helpUrl: 'https://login.yahoo.com/account/security/app-passwords',
    cacheLimit: 5000
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'sent.com', 'messagingengine.com'],
    imap: tls('imap.fastmail.com', 993),
    smtp: tls('smtp.fastmail.com', 465),
    authTypes: ['password'],
    help:
      'Fastmail requires an app password. In Fastmail go to Settings > Privacy & Security > ' +
      'Connected apps & app passwords, create a password with IMAP and SMTP access, and paste ' +
      'it here.',
    helpUrl: 'https://app.fastmail.com/settings/security/devicekeys',
    cacheLimit: 5000
  },
  {
    id: 'imap',
    label: 'Other (IMAP)',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    authTypes: ['password'],
    help:
      'Enter the IMAP and SMTP servers from your provider. Estuary will try to find them ' +
      'automatically from your address first.',
    cacheLimit: 5000
  }
]

/**
 * Domains that are matched by shape rather than by an exact entry in `domains`.
 * Yahoo alone has dozens of country domains, so a pattern beats an ever-growing list.
 */
const DOMAIN_PATTERNS: { id: ProviderId; test: RegExp }[] = [
  { id: 'yahoo', test: /^yahoo\.[a-z]{2,3}(\.[a-z]{2})?$/ },
  { id: 'gmail', test: /^googlemail\.[a-z]{2,3}(\.[a-z]{2})?$/ }
]

export function presets(): ProviderPreset[] {
  return PRESETS
}

export function presetById(id: ProviderId): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** Lower-cased domain part of an address, or undefined when it is not an address. */
export function domainOf(email: string): string | undefined {
  const at = String(email ?? '').trim().toLowerCase().lastIndexOf('@')
  if (at < 1) return undefined
  const domain = String(email).trim().toLowerCase().slice(at + 1)
  // Reject obvious junk; a domain needs at least one dot and no whitespace.
  if (!domain || /\s/.test(domain) || !domain.includes('.')) return undefined
  return domain.replace(/\.+$/, '')
}

/**
 * Preset for an email address, by domain. Returns undefined (not the generic `imap`
 * preset) when nothing matches, so callers can decide whether to run autodetect.
 */
export function presetForEmail(email: string): ProviderPreset | undefined {
  const domain = domainOf(email)
  if (!domain) return undefined
  const exact = PRESETS.find((p) => p.domains.includes(domain))
  if (exact) return exact
  const pattern = DOMAIN_PATTERNS.find((p) => p.test.test(domain))
  return pattern ? presetById(pattern.id) : undefined
}
