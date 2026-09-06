/**
 * One IMAP connection per role (long lived IDLE listener, or the worker used for
 * fetches and actions), with credential refresh, timeouts and exponential backoff.
 */
import { ImapFlow } from 'imapflow'
import log from 'electron-log/main'
import type { AccountInput, ServerSettings } from '@shared/types'
import type { AuthService, MailStore } from '../contracts'

const imapLog = log.scope('imap')

export type ConnectionRole = 'idle' | 'worker'

export const CONNECT_TIMEOUT_MS = 30_000
export const COMMAND_TIMEOUT_MS = 120_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 5 * 60_000

export interface ErrorInfo {
  kind: 'auth' | 'network' | 'other'
  message: string
  needsReauth: boolean
}

const AUTH_PATTERNS = [
  /AUTHENTICATIONFAILED/i,
  /AUTHORIZATIONFAILED/i,
  /invalid_grant/i,
  /invalid credentials/i,
  /authentication fail/i,
  /\[ALERT\].*password/i,
  /LOGIN failed/i,
  /Invalid login/i,
  /Username and Password not accepted/i,
  /application-specific password/i,
  /Re-?authentication required/i,
  /basic authentication is disabled/i
]

const NETWORK_PATTERNS = [
  /ENOTFOUND/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /timed? ?out/i,
  /socket/i,
  /getaddrinfo/i,
  /Connection closed/i,
  /offline/i
]

export function errorMessage(err: unknown): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  const anyErr = err as { message?: string; responseText?: string; response?: string; code?: string; authenticationFailed?: boolean }
  return anyErr.responseText ?? anyErr.response ?? anyErr.message ?? anyErr.code ?? String(err)
}

export function classifyError(err: unknown): ErrorInfo {
  const message = errorMessage(err)
  const flagged = (err as { authenticationFailed?: boolean } | null)?.authenticationFailed === true
  if (flagged || AUTH_PATTERNS.some((re) => re.test(message))) {
    return { kind: 'auth', message, needsReauth: true }
  }
  if (NETWORK_PATTERNS.some((re) => re.test(message))) return { kind: 'network', message, needsReauth: false }
  return { kind: 'other', message, needsReauth: false }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ResolvedAuth {
  user: string
  pass?: string
  accessToken?: string
}

/** Credentials for an AccountInput that is not stored yet (account wizard / test). */
export async function resolveAuthForInput(input: AccountInput, auth: AuthService): Promise<ResolvedAuth> {
  const user = input.username || input.email
  if (input.authType === 'oauth2') {
    if (!input.oauth) throw new Error('This account needs to be authorised before it can connect.')
    const fresh = await auth.ensureFreshTokens(input.oauth)
    return { user, accessToken: fresh.accessToken }
  }
  if (!input.password) throw new Error('No password was provided for this account.')
  return { user, pass: input.password }
}

/** Credentials for a stored account; refreshes and persists OAuth tokens when needed. */
export async function resolveAuthForAccount(accountId: string, store: MailStore, auth: AuthService): Promise<ResolvedAuth> {
  const account = store.getAccount(accountId)
  if (!account) throw new Error('Account not found')
  const secret = store.getAccountSecret(accountId)
  const user = account.username || account.email
  if (account.authType === 'oauth2') {
    if (!secret?.oauth) {
      const err = new Error('AUTHENTICATIONFAILED: no stored OAuth tokens, please sign in again')
      throw err
    }
    const fresh = await auth.ensureFreshTokens(secret.oauth)
    if (fresh.accessToken !== secret.oauth.accessToken || fresh.expiresAt !== secret.oauth.expiresAt) {
      try {
        store.setAccountOAuth(accountId, fresh)
      } catch (err) {
        imapLog.warn('could not persist refreshed tokens', errorMessage(err))
      }
    }
    return { user, accessToken: fresh.accessToken }
  }
  if (!secret?.password) throw new Error('AUTHENTICATIONFAILED: no stored password, please re-enter it in Settings')
  return { user, pass: secret.password }
}

export type ImapOptions = ConstructorParameters<typeof ImapFlow>[0]

export function buildImapOptions(server: ServerSettings, credentials: ResolvedAuth, role: ConnectionRole = 'worker'): ImapOptions {
  const options = {
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: credentials.accessToken
      ? { user: credentials.user, accessToken: credentials.accessToken }
      : { user: credentials.user, pass: credentials.pass ?? '' },
    logger: false as const,
    clientInfo: { name: 'UniMail', version: '0.1.0' },
    greetingTimeout: 20_000,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: role === 'idle' ? 10 * 60_000 : COMMAND_TIMEOUT_MS,
    // The worker connection must never sit in IDLE - it has to answer commands at once.
    disableAutoIdle: role === 'worker',
    maxIdleTime: 4 * 60_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
    emitLogs: false
  }
  return options as unknown as ImapOptions
}

export interface ConnectionHooks {
  /** Called after every successful (re)connect, before the connection is handed out. */
  onConnected?: (client: ImapFlow, connection: AccountConnection) => void | Promise<void>
  onClosed?: (connection: AccountConnection) => void
  onAuthError?: (message: string, needsReauth: boolean) => void
  onNetworkError?: (message: string) => void
}

export interface ConnectionDeps {
  store: MailStore
  auth: AuthService
  hooks?: ConnectionHooks
}

/**
 * A single ImapFlow client with lazy connect, reconnect backoff and mailbox locking.
 * Never throws out of its own timers/handlers.
 */
export class AccountConnection {
  readonly accountId: string
  readonly role: ConnectionRole
  needsReauth = false
  lastError: string | undefined

  private client: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private attempt = 0
  private stopped = false
  private readonly deps: ConnectionDeps

  constructor(accountId: string, role: ConnectionRole, deps: ConnectionDeps) {
    this.accountId = accountId
    this.role = role
    this.deps = deps
  }

  get connected(): boolean {
    const client = this.client as (ImapFlow & { usable?: boolean }) | null
    return !!client && client.usable !== false
  }

  get raw(): ImapFlow | null {
    return this.client
  }

  /** Connect if needed and return the live client. */
  async ensure(): Promise<ImapFlow> {
    if (this.stopped) throw new Error('Connection stopped')
    if (this.connected && this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = this.openClient()
      .then((client) => {
        this.connecting = null
        return client
      })
      .catch((err) => {
        this.connecting = null
        throw err
      })
    return this.connecting
  }

  private async openClient(): Promise<ImapFlow> {
    const account = this.deps.store.getAccount(this.accountId)
    if (!account) throw new Error('Account not found')
    let credentials: ResolvedAuth
    try {
      credentials = await resolveAuthForAccount(this.accountId, this.deps.store, this.deps.auth)
    } catch (err) {
      this.handleFailure(err)
      throw err
    }

    const client = new ImapFlow(buildImapOptions(account.imap, credentials, this.role))
    // ImapFlow emits 'error' on socket failures; an unhandled 'error' would kill the process.
    client.on('error', (err: unknown) => {
      const info = classifyError(err)
      this.lastError = info.message
      imapLog.warn(`[${account.email}/${this.role}] socket error: ${info.message}`)
    })
    client.on('close', () => {
      if (this.client === client) {
        this.client = null
        try {
          this.deps.hooks?.onClosed?.(this)
        } catch (err) {
          imapLog.warn('onClosed hook failed', errorMessage(err))
        }
        if (!this.stopped && !this.needsReauth) this.scheduleReconnect()
      }
    })

    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, `Connecting to ${account.imap.host}`)
    } catch (err) {
      try {
        client.close()
      } catch {
        /* ignore */
      }
      this.handleFailure(err)
      throw err
    }

    this.client = client
    this.attempt = 0
    this.needsReauth = false
    this.lastError = undefined
    imapLog.info(`[${account.email}/${this.role}] connected to ${account.imap.host}`)
    try {
      await this.deps.hooks?.onConnected?.(client, this)
    } catch (err) {
      imapLog.warn('onConnected hook failed', errorMessage(err))
    }
    return client
  }

  private handleFailure(err: unknown): void {
    const info = classifyError(err)
    this.lastError = info.message
    if (info.kind === 'auth') {
      this.needsReauth = true
      this.deps.hooks?.onAuthError?.(info.message, true)
      return
    }
    this.deps.hooks?.onNetworkError?.(info.message)
    // A connect that never succeeded emits no 'close' we can hang a retry on.
    this.scheduleReconnect()
  }

  /** Reconnect later with exponential backoff (1s .. 5min). */
  scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.attempt, 10))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.ensure().catch((err) => {
        imapLog.warn(`[${this.accountId}/${this.role}] reconnect failed: ${errorMessage(err)}`)
        if (!this.needsReauth) this.scheduleReconnect()
      })
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  /** Clear the reauth latch (after the user re-authorised) and reconnect soon. */
  resetAuth(): void {
    this.needsReauth = false
    this.attempt = 0
    if (!this.stopped) this.scheduleReconnect()
  }

  supports(capability: string): boolean {
    const client = this.client as (ImapFlow & { capabilities?: Map<string, unknown> }) | null
    if (!client?.capabilities) return false
    const wanted = capability.toUpperCase()
    for (const key of client.capabilities.keys()) {
      if (String(key).toUpperCase() === wanted) return true
    }
    return false
  }

  /** Run `fn` with an exclusive lock on `path`. The lock is always released. */
  async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.ensure()
    const lock = await withTimeout(client.getMailboxLock(path), COMMAND_TIMEOUT_MS, `Opening ${path}`)
    try {
      return await fn(client)
    } finally {
      try {
        lock.release()
      } catch (err) {
        imapLog.warn('lock release failed', errorMessage(err))
      }
    }
  }

  async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.ensure()
    return fn(client)
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const client = this.client
    this.client = null
    this.connecting = null
    if (!client) return
    try {
      await withTimeout(client.logout(), 5_000, 'Logout')
    } catch {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
  }
}
