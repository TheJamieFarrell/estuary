/**
 * Seeds `settings.oauthClients` from a local JSON file so the user never has to paste
 * client ids by hand. Dev: `<project>/config/oauth-clients.local.json` (gitignored).
 * Packaged: `<resources>/oauth-clients.json` (copied by electron-builder extraResources).
 * Only fills providers that are not already configured; never overwrites user edits.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { MailStore } from '@main/contracts'
import type { AppSettings, OAuthProvider } from '@shared/types'

type SeedFile = Partial<Record<OAuthProvider, { clientId?: string; clientSecret?: string }>>

const scope = log.scope('oauth-seed')

export function seedFilePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'oauth-clients.json')
    : join(app.getAppPath(), 'config', 'oauth-clients.local.json')
}

export function seedOAuthClients(store: MailStore): void {
  const file = seedFilePath()
  if (!existsSync(file)) return
  let seed: SeedFile
  try {
    seed = JSON.parse(readFileSync(file, 'utf8')) as SeedFile
  } catch (err) {
    scope.warn(`could not parse ${file}`, err)
    return
  }
  const current = store.getSettings().oauthClients ?? {}
  const next: AppSettings['oauthClients'] = { ...current }
  let changed = false
  for (const provider of ['google', 'microsoft'] as OAuthProvider[]) {
    const entry = seed[provider]
    if (!entry?.clientId) continue
    if (current[provider]?.clientId) continue
    next[provider] = { clientId: entry.clientId, clientSecret: entry.clientSecret }
    changed = true
  }
  if (changed) {
    store.setSettings({ oauthClients: next })
    scope.info(`seeded OAuth clients from ${file}: ${Object.keys(next).join(', ')}`)
  }
}
