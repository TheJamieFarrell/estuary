/**
 * Loopback OAuth 2.0 + PKCE for Google and Microsoft.
 *
 * RFC 8252 (OAuth for native apps): spin up an ephemeral HTTP server on the loopback
 * interface, send the user to the provider in their *system* browser, and catch the
 * authorization code on the loopback redirect. No embedded webview, no client secret
 * required (Google desktop clients ship one anyway; it is not treated as a secret).
 *
 * Redirect URIs, which is what the user has to register:
 *   Google     http://127.0.0.1:<random port>/callback   ("Desktop app" client -
 *              Google accepts any loopback port and path, nothing to register)
 *   Microsoft  http://localhost:<random port>            (register exactly
 *              `http://localhost` under "Mobile and desktop applications";
 *              Entra ignores the port for localhost, and the Azure portal refuses
 *              http://127.0.0.1 in the redirect URI box)
 *
 * We listen on 127.0.0.1 and, when possible, additionally on [::1] with the same port,
 * so that whichever address the browser picks for `localhost` reaches us.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthProvider, OAuthResult, OAuthStartRequest, OAuthTokens } from '@shared/types'

export type OAuthStep = 'waitingForBrowser' | 'exchanging' | 'done' | 'error'
export type OAuthProgress = (step: OAuthStep, message?: string) => void

/** Prefix on thrown refresh errors that means "the user must sign in again". */
export const REAUTH_PREFIX = 'REAUTH_REQUIRED:'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export interface OAuthDeps {
  /** Defaults to Electron's shell.openExternal, guarded so unit tests can run in plain node. */
  openUrl?: (url: string) => Promise<void>
  fetchFn?: typeof fetch
}

export interface ProviderConfig {
  authUrl: string
  tokenUrl: string
  scope: string
  /** Extra query params on the authorization request. */
  authParams: Record<string, string>
  redirectUri: (port: number) => string
  /** Path the callback is expected on ('' = any). */
  callbackPath: string
  /** Google desktop clients have one; Microsoft public clients must not send one. */
  allowClientSecret: boolean
  userinfoUrl?: string
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email',
    authParams: { access_type: 'offline', prompt: 'consent' },
    redirectUri: (port) => `http://127.0.0.1:${port}/callback`,
    callbackPath: '/callback',
    allowClientSecret: true,
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo'
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:
      'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email',
    authParams: { response_mode: 'query' },
    redirectUri: (port) => `http://localhost:${port}`,
    callbackPath: '',
    allowClientSecret: false
  }
}

export function providerConfig(provider: OAuthProvider): ProviderConfig {
  const cfg = PROVIDERS[provider]
  if (!cfg) throw new Error(`Unknown OAuth provider: ${String(provider)}`)
  return cfg
}

/** The redirect URI a user must register in the provider console, without the port. */
export function registrableRedirectUri(provider: OAuthProvider): string {
  return provider === 'microsoft' ? 'http://localhost' : 'http://127.0.0.1/callback'
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** base64url-decode a JWT payload. No signature verification - the token came straight
 *  from the provider's token endpoint over TLS, we only want the `email` claim. */
export function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  const payload = parts[1]
  if (!payload) return null
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8'
    )
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function emailFromClaims(claims: Record<string, unknown> | null): string | undefined {
  if (!claims) return undefined
  for (const key of ['email', 'preferred_username', 'upn', 'unique_name']) {
    const v = claims[key]
    if (typeof v === 'string' && v.includes('@')) return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Callback HTML
// ---------------------------------------------------------------------------

function resultPage(title: string, body: string, ok: boolean): string {
  const accent = ok ? '#2f855a' : '#c53030'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UniMail</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f6f7f9; color: #1a202c;
  }
  .card {
    max-width: 26rem; margin: 2rem; padding: 2rem 2.25rem; text-align: center;
    background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
  }
  .mark {
    width: 46px; height: 46px; margin: 0 auto 1rem; border-radius: 50%;
    display: grid; place-items: center; font-size: 24px; font-weight: 700; color: #fff;
    background: ${accent};
  }
  h1 { margin: 0 0 .4rem; font-size: 1.15rem; }
  p { margin: 0; color: #4a5568; }
  @media (prefers-color-scheme: dark) {
    body { background: #12151a; color: #e8eaed; }
    .card { background: #1b1f26; border-color: #2c323c; box-shadow: none; }
    p { color: #a6adba; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${ok ? '&#10003;' : '!'}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`
}

const SUCCESS_PAGE = resultPage(
  'Signed in',
  'You can return to UniMail and close this tab.',
  true
)

function failurePage(message: string): string {
  const safe = message.replace(/[<>&"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'
  )
  return resultPage('Sign-in failed', `${safe} You can return to UniMail and try again.`, false)
}

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

interface Loopback {
  port: number
  close(): void
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

function listenLoopback(handler: Handler): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    const primary = createServer(handler)
    primary.on('error', reject)
    primary.listen(0, '127.0.0.1', () => {
      const addr = primary.address() as AddressInfo | null
      const port = addr?.port
      if (!port) {
        primary.close()
        reject(new Error('Could not open a local port for the sign-in redirect.'))
        return
      }
      // Windows resolves `localhost` to ::1 first. Try to answer there too so the
      // Microsoft `http://localhost:<port>` redirect lands without a fallback hop.
      let secondary: Server | undefined
      const done = () =>
        resolve({
          port,
          close: () => {
            try {
              primary.close()
            } catch {
              /* ignore */
            }
            try {
              secondary?.close()
            } catch {
              /* ignore */
            }
          }
        })
      try {
        const s = createServer(handler)
        s.on('error', () => done())
        s.listen(port, '::1', () => {
          secondary = s
          done()
        })
      } catch {
        done()
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Browser launch (Electron guarded so vitest can import this module)
// ---------------------------------------------------------------------------

async function defaultOpenUrl(url: string): Promise<void> {
  try {
    const electron: unknown = await import('electron')
    const shell = (electron as { shell?: { openExternal?: (u: string) => Promise<void> } })?.shell
    if (shell && typeof shell.openExternal === 'function') {
      await shell.openExternal(url)
      return
    }
  } catch {
    /* not running inside Electron */
  }
  throw new Error('Could not open the system browser.')
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

interface ActiveFlow {
  cancel(reason: string): void
}

let activeFlow: ActiveFlow | null = null

export function cancelOAuth(): void {
  activeFlow?.cancel('Sign-in was cancelled.')
}

export async function startOAuth(
  req: OAuthStartRequest,
  onProgress?: OAuthProgress,
  deps: OAuthDeps = {}
): Promise<OAuthResult> {
  const progress: OAuthProgress = (step, message) => {
    try {
      onProgress?.(step, message)
    } catch {
      /* a broken listener must not kill the flow */
    }
  }
  const doFetch = deps.fetchFn ?? fetch
  const openUrl = deps.openUrl ?? defaultOpenUrl

  let cfg: ProviderConfig
  try {
    cfg = providerConfig(req.provider)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    progress('error', message)
    return { ok: false, error: message }
  }

  const clientId = (req.clientId ?? '').trim()
  if (!clientId) {
    const message = `No ${req.provider === 'google' ? 'Google' : 'Microsoft'} client ID configured. Add one in Settings > Accounts (see docs/OAUTH-SETUP.md).`
    progress('error', message)
    return { ok: false, error: message }
  }
  const clientSecret = cfg.allowClientSecret ? (req.clientSecret ?? '').trim() : ''

  // Only one flow at a time; a second start cancels the first.
  cancelOAuth()

  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(16))

  let settle: ((value: { code?: string; error?: string }) => void) | null = null
  const waitForCode = new Promise<{ code?: string; error?: string }>((resolve) => {
    settle = resolve
  })
  const finish = (value: { code?: string; error?: string }) => {
    const s = settle
    settle = null
    s?.(value)
  }

  let loopback: Loopback | null = null
  let timer: NodeJS.Timeout | null = null

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    timer = null
    loopback?.close()
    loopback = null
    if (activeFlow === flowHandle) activeFlow = null
  }

  const flowHandle: ActiveFlow = {
    cancel: (reason) => finish({ error: reason })
  }
  activeFlow = flowHandle

  try {
    const handler: Handler = (httpReq, httpRes) => {
      const url = new URL(httpReq.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/favicon.ico') {
        httpRes.writeHead(404).end()
        return
      }
      if (cfg.callbackPath && url.pathname !== cfg.callbackPath && url.pathname !== '/') {
        httpRes.writeHead(404).end()
        return
      }

      const params = url.searchParams
      const returnedState = params.get('state') ?? ''
      const send = (status: number, html: string) => {
        httpRes.writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close'
        })
        httpRes.end(html)
      }

      if (!returnedState || !safeEqual(returnedState, state)) {
        send(400, failurePage('The sign-in response did not match this request.'))
        return
      }

      const err = params.get('error')
      if (err) {
        const desc = params.get('error_description') ?? err
        send(400, failurePage(desc))
        finish({ error: desc })
        return
      }

      const code = params.get('code')
      if (!code) {
        send(400, failurePage('No authorization code was returned.'))
        finish({ error: 'No authorization code was returned.' })
        return
      }

      send(200, SUCCESS_PAGE)
      finish({ code })
    }

    loopback = await listenLoopback(handler)
    const redirectUri = cfg.redirectUri(loopback.port)

    const authUrl = new URL(cfg.authUrl)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', cfg.scope)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    for (const [k, v] of Object.entries(cfg.authParams)) authUrl.searchParams.set(k, v)
    if (req.email) authUrl.searchParams.set('login_hint', req.email)

    timer = setTimeout(
      () => finish({ error: 'Timed out waiting for the browser sign-in (5 minutes).' }),
      CALLBACK_TIMEOUT_MS
    )

    progress('waitingForBrowser', 'Finish signing in in your browser.')
    try {
      await openUrl(authUrl.toString())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cleanup()
      progress('error', message)
      return { ok: false, error: message }
    }

    const outcome = await waitForCode
    if (outcome.error || !outcome.code) {
      cleanup()
      const message = outcome.error ?? 'Sign-in did not complete.'
      progress('error', message)
      return { ok: false, error: message }
    }

    progress('exchanging', 'Exchanging the authorization code.')
    const tokens = await exchangeCode({
      cfg,
      provider: req.provider,
      clientId,
      clientSecret,
      code: outcome.code,
      redirectUri,
      verifier,
      doFetch
    })
    cleanup()
    progress('done')
    return { ok: true, tokens, email: tokens.email }
  } catch (err) {
    cleanup()
    const message = err instanceof Error ? err.message : String(err)
    progress('error', message)
    return { ok: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
  token_type?: string
  error?: string
  error_description?: string
}

async function postForm(
  url: string,
  body: Record<string, string>,
  doFetch: typeof fetch
): Promise<TokenResponse> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams(body).toString()
  })
  const text = await res.text()
  let json: TokenResponse
  try {
    json = JSON.parse(text) as TokenResponse
  } catch {
    throw new Error(`The token endpoint returned an unexpected response (HTTP ${res.status}).`)
  }
  if (!res.ok || json.error) {
    const detail = json.error_description ?? json.error ?? `HTTP ${res.status}`
    const e = new Error(detail) as Error & { oauthError?: string }
    e.oauthError = json.error
    throw e
  }
  return json
}

async function exchangeCode(args: {
  cfg: ProviderConfig
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  verifier: string
  doFetch: typeof fetch
}): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier
  }
  if (args.cfg.allowClientSecret && args.clientSecret) body.client_secret = args.clientSecret
  if (args.provider === 'microsoft') body.scope = args.cfg.scope

  const json = await postForm(args.cfg.tokenUrl, body, args.doFetch)
  if (!json.access_token) throw new Error('The provider did not return an access token.')

  let email = emailFromClaims(decodeJwtPayload(json.id_token))
  if (!email && args.cfg.userinfoUrl) {
    email = await fetchUserinfoEmail(args.cfg.userinfoUrl, json.access_token, args.doFetch)
  }

  const tokens: OAuthTokens = {
    provider: args.provider,
    clientId: args.clientId,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? args.cfg.scope
  }
  if (args.cfg.allowClientSecret && args.clientSecret) tokens.clientSecret = args.clientSecret
  if (email) tokens.email = email
  return tokens
}

async function fetchUserinfoEmail(
  url: string,
  accessToken: string,
  doFetch: typeof fetch
): Promise<string | undefined> {
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as Record<string, unknown>
    const email = json.email
    return typeof email === 'string' ? email : undefined
  } catch {
    return undefined
  }
}

/**
 * Refresh an access token. Throws an Error whose message starts with REAUTH_REQUIRED:
 * when the refresh token itself is dead (revoked, password changed, consent withdrawn),
 * which the mail engine turns into `needsReauth` on the account.
 */
export async function refreshTokens(
  tokens: OAuthTokens,
  deps: OAuthDeps = {}
): Promise<OAuthTokens> {
  const doFetch = deps.fetchFn ?? fetch
  const cfg = providerConfig(tokens.provider)
  if (!tokens.refreshToken) {
    throw new Error(`${REAUTH_PREFIX} No refresh token is stored for this account.`)
  }
  if (!tokens.clientId) {
    throw new Error(`${REAUTH_PREFIX} No OAuth client ID is configured for this account.`)
  }

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId
  }
  if (cfg.allowClientSecret && tokens.clientSecret) body.client_secret = tokens.clientSecret
  if (tokens.provider === 'microsoft') body.scope = tokens.scope || cfg.scope

  let json: TokenResponse
  try {
    json = await postForm(cfg.tokenUrl, body, doFetch)
  } catch (err) {
    const oauthError = (err as { oauthError?: string })?.oauthError
    const message = err instanceof Error ? err.message : String(err)
    if (oauthError === 'invalid_grant' || /invalid_grant/i.test(message)) {
      throw new Error(`${REAUTH_PREFIX} ${message}`)
    }
    throw err instanceof Error ? err : new Error(message)
  }

  if (!json.access_token) {
    throw new Error(`${REAUTH_PREFIX} The refresh response contained no access token.`)
  }

  return {
    ...tokens,
    accessToken: json.access_token,
    // Providers usually omit refresh_token on refresh; keep the one we already have.
    refreshToken: json.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope || tokens.scope
  }
}

/** Refresh when the access token expires within 60 seconds, otherwise pass through. */
export async function ensureFreshTokens(
  tokens: OAuthTokens,
  deps: OAuthDeps = {}
): Promise<OAuthTokens> {
  if (tokens.expiresAt - 60_000 >= Date.now()) return tokens
  return await refreshTokens(tokens, deps)
}
