/**
 * AuthService: provider presets, server autodetection, loopback OAuth, XOAUTH2.
 *
 * The store is used for exactly one thing here - reading `settings.oauthClients` so the
 * user only ever types their Google / Microsoft client id once. Nothing in this module
 * writes to the store; persisting refreshed tokens is the caller's job (see
 * `MailStore.setAccountOAuth`).
 */
import type { AuthService, MailStore } from '../contracts'
import type {
  OAuthProvider,
  OAuthResult,
  OAuthStartRequest,
  OAuthTokens,
  ProviderPreset,
  ServerSettings
} from '@shared/types'
import { autodetect } from './autodetect'
import { cancelOAuth, ensureFreshTokens, startOAuth } from './oauth'
import { presetForEmail, presets } from './presets'
import { xoauth2 } from './xoauth2'

export function createAuthService(store: MailStore): AuthService {
  /** Client id/secret saved in Settings, used when the caller does not pass one. */
  const storedClient = (
    provider: OAuthProvider
  ): { clientId?: string; clientSecret?: string } => {
    try {
      return store.getSettings().oauthClients?.[provider] ?? {}
    } catch {
      return {}
    }
  }

  return {
    presets(): ProviderPreset[] {
      return presets()
    },

    presetForEmail(email: string): ProviderPreset | undefined {
      return presetForEmail(email)
    },

    async autodetect(
      email: string
    ): Promise<{ imap?: ServerSettings; smtp?: ServerSettings; provider?: string } | null> {
      return await autodetect(email)
    },

    async startOAuth(
      req: OAuthStartRequest,
      onProgress?: (step: string, message?: string) => void
    ): Promise<OAuthResult> {
      const saved = storedClient(req.provider)
      const filled: OAuthStartRequest = {
        ...req,
        clientId: req.clientId || saved.clientId || '',
        clientSecret: req.clientSecret || saved.clientSecret
      }
      return await startOAuth(filled, onProgress)
    },

    cancelOAuth(): void {
      cancelOAuth()
    },

    async ensureFreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
      const saved = storedClient(tokens.provider)
      const filled: OAuthTokens = {
        ...tokens,
        clientId: tokens.clientId || saved.clientId || '',
        clientSecret: tokens.clientSecret || saved.clientSecret
      }
      return await ensureFreshTokens(filled)
    },

    xoauth2(user: string, accessToken: string): string {
      return xoauth2(user, accessToken)
    }
  }
}

export { autodetect, parseAutoconfig, providerFromMx } from './autodetect'
export { cancelOAuth, ensureFreshTokens, refreshTokens, registrableRedirectUri, startOAuth, REAUTH_PREFIX } from './oauth'
export { PRESETS, domainOf, presetById, presetForEmail, presets } from './presets'
export { oauthBearer, xoauth2 } from './xoauth2'
