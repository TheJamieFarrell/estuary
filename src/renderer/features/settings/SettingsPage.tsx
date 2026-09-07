/**
 * Settings screen. Every control writes through `settings:set` immediately - there is no
 * save button - and the page also listens for `settings:changed` so a change made anywhere
 * else (tray, another window) is reflected here.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, OAuthProvider } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from '@renderer/lib/api'
import {
  Button,
  Collapsible,
  Input,
  Row,
  Section,
  Select,
  Spinner,
  Toggle,
  useToast
} from '@renderer/features/common-local/ui'
import './settings.css'

const GOOGLE_CONSOLE_URL = 'https://console.cloud.google.com/auth/clients'
const ENTRA_PORTAL_URL =
  'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'

const THEMES: { value: AppSettings['theme']; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow Windows' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' }
]

const MARK_READ_OPTIONS = [
  { value: '0', label: 'Immediately' },
  { value: '1500', label: 'After 1.5 seconds' },
  { value: '3000', label: 'After 3 seconds' },
  { value: '-1', label: 'Never' }
]

const POLL_OPTIONS = [
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '900', label: 'Every 15 minutes' },
  { value: '1800', label: 'Every 30 minutes' }
]

interface VersionInfo {
  version: string
  electron: string
  platform: string
  /** Present only if main adds it; see the note in the settings report. */
  logPath?: string
}

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [googleId, setGoogleId] = useState('')
  const [googleSecret, setGoogleSecret] = useState('')
  const [microsoftId, setMicrosoftId] = useState('')
  const toast = useToast()

  // ------------------------------------------------------------------ load --

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await api.invoke('settings:get', undefined)
        if (cancelled) return
        setSettings(s)
        setGoogleId(s.oauthClients?.google?.clientId ?? '')
        setGoogleSecret(s.oauthClients?.google?.clientSecret ?? '')
        setMicrosoftId(s.oauthClients?.microsoft?.clientId ?? '')
      } catch {
        if (!cancelled) setSettings(DEFAULT_SETTINGS)
      }
    })()
    void api
      .invoke('app:version', undefined)
      .then((v) => {
        if (!cancelled) setVersion(v as VersionInfo)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () =>
      api.on('settings:changed', (next) => {
        setSettings(next)
      }),
    []
  )

  // ----------------------------------------------------------------- write --

  const patch = useCallback(
    async (change: Partial<AppSettings>) => {
      setSettings((cur) => (cur ? { ...cur, ...change } : cur))
      try {
        const next = await api.invoke('settings:set', change)
        setSettings(next)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save that setting')
      }
    },
    [toast]
  )

  const saveOauthClient = useCallback(
    (provider: OAuthProvider, clientId: string, clientSecret?: string) => {
      const current = settings?.oauthClients ?? {}
      const trimmedId = clientId.trim()
      const nextClients = { ...current }
      if (!trimmedId) delete nextClients[provider]
      else nextClients[provider] = { clientId: trimmedId, clientSecret: clientSecret?.trim() || undefined }
      void patch({ oauthClients: nextClients })
    },
    [settings, patch]
  )

  const openExternal = useCallback(
    (url: string) => {
      void api.invoke('app:openExternal', { url }).catch(() => {
        toast.error('Could not open the browser')
      })
    },
    [toast]
  )

  const pickDownloadDir = useCallback(async () => {
    try {
      const dir = await api.invoke('app:pickDirectory', undefined)
      if (dir) void patch({ downloadDir: dir })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not choose a folder')
    }
  }, [patch, toast])

  const openLogFolder = useCallback(() => {
    // main may expose the real path on `app:version`; fall back to a well-known relative hint.
    const path = version?.logPath ?? 'logs'
    void api.invoke('app:showItemInFolder', { path }).catch(() => {
      toast.error('Could not open the log folder')
    })
  }, [version, toast])

  // ------------------------------------------------------------------ view --

  if (!settings) {
    return (
      <div className="st-page st-loading">
        <Spinner size={22} label="Loading settings" />
      </div>
    )
  }

  return (
    <div className="st-page">
      <div className="st-inner">
        <h1 className="st-heading">Settings</h1>

        <Section title="Appearance">
          <Row label="Theme">
            <div className="st-theme-cards" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === t.value}
                  className={`st-theme-card ${settings.theme === t.value ? 'is-selected' : ''}`}
                  onClick={() => void patch({ theme: t.value })}
                >
                  <span className={`st-theme-swatch st-theme-swatch--${t.value}`} aria-hidden="true" />
                  <span className="st-theme-label">{t.label}</span>
                  <span className="st-theme-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          </Row>

          <Row label="Density" description="Compact fits more messages on screen.">
            <Select
              value={settings.density}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' }
              ]}
              onChange={(e) =>
                void patch({ density: e.currentTarget.value as AppSettings['density'] })
              }
            />
          </Row>
        </Section>

        <Section title="Notifications">
          <Row label="Desktop notifications" description="Show a notification when new mail arrives.">
            <Toggle
              checked={settings.notificationsEnabled}
              title="Desktop notifications"
              onChange={(v) => void patch({ notificationsEnabled: v })}
            />
          </Row>
          <Row label="Notification sound">
            <Toggle
              checked={settings.notificationSound}
              disabled={!settings.notificationsEnabled}
              title="Notification sound"
              onChange={(v) => void patch({ notificationSound: v })}
            />
          </Row>
        </Section>

        <Section title="Behaviour">
          <Row label="Start Estuary when I sign in">
            <Toggle
              checked={settings.startOnLogin}
              title="Start on login"
              onChange={(v) => void patch({ startOnLogin: v })}
            />
          </Row>
          <Row label="Minimise to the tray" description="Closing the window keeps Estuary running in the notification area.">
            <Toggle
              checked={settings.minimizeToTray}
              title="Minimise to tray"
              onChange={(v) => void patch({ minimizeToTray: v })}
            />
          </Row>
          <Row label="Mark as read" description="How long a message stays unread after you open it.">
            <Select
              value={String(settings.markReadDelayMs)}
              options={MARK_READ_OPTIONS}
              onChange={(e) => void patch({ markReadDelayMs: Number(e.currentTarget.value) })}
            />
          </Row>
          <Row label="Check for new mail" description="Folders without a live connection are polled on this interval.">
            <Select
              value={String(settings.pollIntervalSec)}
              options={POLL_OPTIONS}
              onChange={(e) => void patch({ pollIntervalSec: Number(e.currentTarget.value) })}
            />
          </Row>
        </Section>

        <Section title="Privacy">
          <Row
            label="Load remote images"
            description="Remote images can tell the sender that you opened the message. When off you can still load them per message."
          >
            <Toggle
              checked={settings.loadRemoteImages}
              title="Load remote images"
              onChange={(v) => void patch({ loadRemoteImages: v })}
            />
          </Row>
        </Section>

        <Section title="Downloads">
          <Row label="Save attachments to" description={settings.downloadDir || 'Ask every time'}>
            <Button onClick={() => void pickDownloadDir()}>Change…</Button>
            {settings.downloadDir && (
              <Button variant="ghost" onClick={() => void patch({ downloadDir: undefined })}>
                Reset
              </Button>
            )}
          </Row>
        </Section>

        <Section
          title="Connected apps"
          description="Gmail and Outlook sign-in needs your own OAuth client. You enter it once here; Estuary never sends it anywhere but the provider."
        >
          <Row label="Google client ID" description="From a Desktop app OAuth client in Google Cloud.">
            <Input
              className="st-wide"
              value={googleId}
              placeholder="1234-abc.apps.googleusercontent.com"
              spellCheck={false}
              onChange={(e) => setGoogleId(e.currentTarget.value)}
              onBlur={() => saveOauthClient('google', googleId, googleSecret)}
            />
          </Row>
          <Row label="Google client secret" description="Desktop clients have one; it is not a real secret but Google still requires it.">
            <Input
              className="st-wide"
              type="password"
              value={googleSecret}
              placeholder="GOCSPX-…"
              spellCheck={false}
              onChange={(e) => setGoogleSecret(e.currentTarget.value)}
              onBlur={() => saveOauthClient('google', googleId, googleSecret)}
            />
          </Row>
          <Row label="Microsoft client ID" description="A public client application registration. No secret is needed.">
            <Input
              className="st-wide"
              value={microsoftId}
              placeholder="00000000-0000-0000-0000-000000000000"
              spellCheck={false}
              onChange={(e) => setMicrosoftId(e.currentTarget.value)}
              onBlur={() => saveOauthClient('microsoft', microsoftId)}
            />
          </Row>

          <Collapsible summary="How do I get these?">
            <p className="st-help-title">Google (Gmail)</p>
            <ol className="st-steps">
              <li>Create a Google Cloud project, then enable the <strong>Gmail API</strong> in it.</li>
              <li>Configure the Google Auth Platform branding and audience, adding yourself as a test user.</li>
              <li>Under Clients, create a client of application type <strong>Desktop app</strong>.</li>
              <li>Copy the client ID and client secret into the fields above — the secret is only shown once.</li>
            </ol>
            <p className="st-help-title">Microsoft (Outlook / Microsoft 365)</p>
            <ol className="st-steps">
              <li>Open the Microsoft Entra admin centre › App registrations › New registration.</li>
              <li>Supported account types: any organizational directory <em>and</em> personal Microsoft accounts.</li>
              <li>Add a <strong>Public client/native</strong> redirect URI of exactly <code>http://localhost</code> — no port, no path.</li>
              <li>Copy the Application (client) ID into the field above. No secret is needed.</li>
            </ol>
            <p className="st-help-note">
              The full walkthrough, including the exact scopes Estuary asks for, is in
              <code> docs/OAUTH-SETUP.md</code> in the app repository.
            </p>
            <div className="st-help-buttons">
              <Button onClick={() => openExternal(GOOGLE_CONSOLE_URL)}>Open Google Cloud console</Button>
              <Button onClick={() => openExternal(ENTRA_PORTAL_URL)}>Open Entra portal</Button>
            </div>
          </Collapsible>
        </Section>

        <Section title="About">
          <Row label="Version">
            <span className="st-about-value">
              {version ? `Estuary ${version.version}` : '—'}
            </span>
          </Row>
          <Row label="Runtime">
            <span className="st-about-value">
              {version ? `Electron ${version.electron} · ${version.platform}` : '—'}
            </span>
          </Row>
          <Row label="Updates" description="Installs a newer build in place. Accounts, sign-ins and cached mail are kept.">
            <Button
              onClick={() => {
                void api
                  .invoke('update:check', undefined)
                  .then((u) => {
                    if (!u) toast.success('You are on the latest build')
                    else toast.info(`Estuary ${u.version} is ready — use the banner at the top to install it`)
                  })
                  .catch(() => toast.error('Could not check for updates'))
              }}
            >
              Check for updates
            </Button>
          </Row>
          <Row label="Logs" description="Useful when reporting a sync problem.">
            <Button onClick={openLogFolder}>Open log folder</Button>
          </Row>
        </Section>
      </div>
    </div>
  )
}

export default SettingsPage
