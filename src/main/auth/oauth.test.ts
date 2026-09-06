import { describe, expect, it, vi } from 'vitest'
import type { OAuthTokens } from '@shared/types'
import {
  REAUTH_PREFIX,
  cancelOAuth,
  createPkce,
  decodeJwtPayload,
  ensureFreshTokens,
  providerConfig,
  refreshTokens,
  registrableRedirectUri,
  startOAuth
} from './oauth'

const base64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const googleTokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
  provider: 'google',
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret',
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  scope: 'https://mail.google.com/ openid email',
  ...over
})

/** Minimal fetch stub: returns `body` as JSON with the given status. */
const jsonFetch = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('provider configuration', () => {
  it('uses the documented Google endpoints, scopes and loopback redirect', () => {
    const g = providerConfig('google')
    expect(g.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(g.tokenUrl).toBe('https://oauth2.googleapis.com/token')
    expect(g.scope).toBe('https://mail.google.com/ openid email')
    expect(g.authParams).toEqual({ access_type: 'offline', prompt: 'consent' })
    expect(g.redirectUri(51234)).toBe('http://127.0.0.1:51234/callback')
    expect(g.allowClientSecret).toBe(true)
  })

  it('uses the documented Microsoft endpoints and the localhost redirect form', () => {
    const m = providerConfig('microsoft')
    expect(m.authUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(m.tokenUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(m.scope).toBe(
      'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email'
    )
    // Entra ignores the port for localhost, and rejects http://127.0.0.1 in the portal.
    expect(m.redirectUri(51234)).toBe('http://localhost:51234')
    expect(m.allowClientSecret).toBe(false)
  })

  it('reports the URI the user must register in each console', () => {
    expect(registrableRedirectUri('microsoft')).toBe('http://localhost')
    expect(registrableRedirectUri('google')).toBe('http://127.0.0.1/callback')
  })
})

describe('createPkce', () => {
  it('produces a url-safe verifier and a matching S256 challenge', async () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).not.toBe(verifier)
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('is different every call', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
  })
})

describe('decodeJwtPayload', () => {
  it('decodes an unverified id_token payload', () => {
    const jwt = `${base64url({ alg: 'RS256' })}.${base64url({ email: 'jamie@example.com' })}.sig`
    expect(decodeJwtPayload(jwt)).toEqual({ email: 'jamie@example.com' })
  })

  it('returns null for malformed input instead of throwing', () => {
    expect(decodeJwtPayload(undefined)).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload('notajwt')).toBeNull()
    expect(decodeJwtPayload('a.!!!.c')).toBeNull()
  })
})

describe('ensureFreshTokens', () => {
  it('passes through a token that is still valid', async () => {
    const fetchFn = vi.fn()
    const tokens = googleTokens()
    await expect(
      ensureFreshTokens(tokens, { fetchFn: fetchFn as unknown as typeof fetch })
    ).resolves.toBe(tokens)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes inside the 60 second window', async () => {
    const fetchFn = jsonFetch(200, { access_token: 'new', expires_in: 3600 })
    const before = Date.now()
    const fresh = await ensureFreshTokens(googleTokens({ expiresAt: Date.now() + 30_000 }), {
      fetchFn
    })
    expect(fresh.accessToken).toBe('new')
    expect(fresh.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
  })
})

describe('refreshTokens', () => {
  it('keeps the existing refresh token when the response omits one', async () => {
    const fresh = await refreshTokens(googleTokens({ expiresAt: 0 }), {
      fetchFn: jsonFetch(200, { access_token: 'new', expires_in: 60 })
    })
    expect(fresh.refreshToken).toBe('rt')
    expect(fresh.scope).toBe('https://mail.google.com/ openid email')
  })

  it('takes a rotated refresh token when one is returned', async () => {
    const fresh = await refreshTokens(googleTokens({ expiresAt: 0 }), {
      fetchFn: jsonFetch(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 60 })
    })
    expect(fresh.refreshToken).toBe('rt2')
  })

  it('flags invalid_grant as REAUTH_REQUIRED', async () => {
    await expect(
      refreshTokens(googleTokens({ expiresAt: 0 }), {
        fetchFn: jsonFetch(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.'
        })
      })
    ).rejects.toThrow(new RegExp(`^${REAUTH_PREFIX}`))
  })

  it('flags a missing refresh token as REAUTH_REQUIRED without a network call', async () => {
    const fetchFn = vi.fn()
    await expect(
      refreshTokens(googleTokens({ refreshToken: '', expiresAt: 0 }), {
        fetchFn: fetchFn as unknown as typeof fetch
      })
    ).rejects.toThrow(new RegExp(`^${REAUTH_PREFIX}`))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not flag a transient server error as REAUTH_REQUIRED', async () => {
    await expect(
      refreshTokens(googleTokens({ expiresAt: 0 }), {
        fetchFn: jsonFetch(503, { error: 'temporarily_unavailable' })
      })
    ).rejects.toThrow(/^(?!REAUTH_REQUIRED)/)
  })

  it('sends the client secret for Google but never for Microsoft', async () => {
    const bodies: string[] = []
    const capture = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 60 }), { status: 200 })
    }) as unknown as typeof fetch

    await refreshTokens(googleTokens({ expiresAt: 0 }), { fetchFn: capture })
    expect(bodies[0]).toContain('client_secret=GOCSPX-secret')

    await refreshTokens(
      googleTokens({ provider: 'microsoft', clientSecret: 'should-be-dropped', expiresAt: 0 }),
      { fetchFn: capture }
    )
    expect(bodies[1]).not.toContain('client_secret')
    expect(bodies[1]).toContain('scope=')
  })
})

describe('startOAuth', () => {
  it('fails fast, without opening a browser, when no client id is configured', async () => {
    const openUrl = vi.fn(async () => {})
    const steps: string[] = []
    const res = await startOAuth({ provider: 'google', clientId: '' }, (s) => steps.push(s), {
      openUrl
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/client ID/i)
    expect(steps).toEqual(['error'])
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('builds a PKCE authorization URL and reports waitingForBrowser', async () => {
    let seen: URL | undefined
    const steps: string[] = []
    const result = startOAuth(
      { provider: 'microsoft', clientId: 'app-guid', email: 'jamie@outlook.com' },
      (s) => steps.push(s),
      {
        openUrl: async (url) => {
          seen = new URL(url)
        }
      }
    )
    // Give the flow a tick to open the "browser", then cancel it.
    await vi.waitFor(() => expect(seen).toBeDefined())
    cancelOAuth()
    const res = await result

    expect(seen!.origin + seen!.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    )
    const p = seen!.searchParams
    expect(p.get('client_id')).toBe('app-guid')
    expect(p.get('response_type')).toBe('code')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('state')).toBeTruthy()
    expect(p.get('login_hint')).toBe('jamie@outlook.com')
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+$/)
    expect(p.get('scope')).toContain('IMAP.AccessAsUser.All')

    expect(steps).toContain('waitingForBrowser')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cancel/i)
  })
})
