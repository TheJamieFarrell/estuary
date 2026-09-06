/**
 * Add / edit account wizard, shown as a modal stepper.
 *
 *   1 Account  email + display name, provider preset (pre-selected from autodetect)
 *   2 Sign in  OAuth button when a client id is configured, otherwise password / app password
 *   3 Servers  auto-filled IMAP + SMTP, with an Advanced section to override
 *   4 Test     per-protocol connection check, accent colour, then add / save
 *
 * Editing never shows a stored secret: leaving the password blank keeps the existing one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  AccountInput,
  AppSettings,
  ConnectionTestResult,
  OAuthProvider,
  OAuthTokens,
  ProviderId,
  ProviderPreset,
  ServerSettings
} from '@shared/types'
import { api } from '@renderer/lib/api'
import {
  Button,
  Collapsible,
  ColorPicker,
  Input,
  Modal,
  Select,
  Spinner,
  Stepper,
  Toggle,
  nextUnusedColor,
  useToast
} from '@renderer/features/common-local/ui'
import { PROVIDER_LABEL } from './AccountCard'

const STEPS = ['Account', 'Sign in', 'Servers', 'Test']

const PROVIDER_ORDER: ProviderId[] = [
  'gmail',
  'outlook',
  'spacemail',
  'icloud',
  'yahoo',
  'fastmail',
  'imap'
]

const OAUTH_LABEL: Record<OAuthProvider, string> = {
  google: 'Sign in with Google',
  microsoft: 'Sign in with Microsoft'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const BLANK_IMAP: ServerSettings = { host: '', port: 993, secure: true }
const BLANK_SMTP: ServerSettings = { host: '', port: 465, secure: true }

export interface AccountWizardProps {
  open: boolean
  /** Present when editing. */
  account?: Account
  /** Colours already in use, so a new account gets an unused one. */
  usedColors: string[]
  settings?: AppSettings
  onClose: () => void
  onSaved: (account: Account) => void
}

export function AccountWizard({
  open,
  account,
  usedColors,
  settings,
  onClose,
  onSaved
}: AccountWizardProps): React.JSX.Element | null {
  const editing = account != null
  const toast = useToast()

  const [step, setStep] = useState(0)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState<ProviderId | ''>('')
  const [detecting, setDetecting] = useState(false)
  const [detectedOnce, setDetectedOnce] = useState(false)

  const [useAppPassword, setUseAppPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [oauth, setOauth] = useState<OAuthTokens | undefined>(undefined)
  const [oauthRunning, setOauthRunning] = useState(false)
  const [oauthMessage, setOauthMessage] = useState('')
  const [oauthError, setOauthError] = useState('')

  const [imap, setImap] = useState<ServerSettings>(BLANK_IMAP)
  const [smtp, setSmtp] = useState<ServerSettings>(BLANK_SMTP)
  const [username, setUsername] = useState('')
  const [color, setColor] = useState('#2f6fed')
  const [signature, setSignature] = useState('')

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const initialised = useRef(false)

  const preset = useMemo(
    () => presets.find((p) => p.id === presetId),
    [presets, presetId]
  )

  // --------------------------------------------------------------- open/reset

  useEffect(() => {
    if (!open) {
      initialised.current = false
      return
    }
    if (initialised.current) return
    initialised.current = true

    setStep(0)
    setPassword('')
    setOauth(undefined)
    setOauthError('')
    setOauthMessage('')
    setOauthRunning(false)
    setTestResult(null)
    setSaveError('')
    setDetectedOnce(false)
    setUseAppPassword(false)

    if (account) {
      setEmail(account.email)
      setName(account.name)
      setPresetId(account.provider)
      setImap(account.imap)
      setSmtp(account.smtp)
      setUsername(account.username)
      setColor(account.color)
      setSignature(account.signature ?? '')
      setUseAppPassword(account.authType === 'password')
      setDetectedOnce(true)
    } else {
      setEmail('')
      setName('')
      setPresetId('')
      setImap(BLANK_IMAP)
      setSmtp(BLANK_SMTP)
      setUsername('')
      setColor(nextUnusedColor(usedColors))
      setSignature('')
    }

    void api
      .invoke('accounts:presets', undefined)
      .then(setPresets)
      .catch(() => setPresets([]))
  }, [open, account, usedColors])

  // ----------------------------------------------------------------- detect

  const applyPreset = useCallback(
    (p: ProviderPreset, keepServers = false) => {
      setPresetId(p.id)
      if (!keepServers) {
        setImap(p.imap)
        setSmtp(p.smtp)
      }
      // A preset that cannot do OAuth is always a password account.
      if (!p.authTypes.includes('oauth2')) setUseAppPassword(true)
      else if (!p.authTypes.includes('password')) setUseAppPassword(false)
    },
    []
  )

  const detect = useCallback(async () => {
    const addr = email.trim()
    if (!EMAIL_RE.test(addr)) return
    setDetecting(true)
    try {
      const [list, guess] = await Promise.all([
        presets.length ? Promise.resolve(presets) : api.invoke('accounts:presets', undefined),
        api.invoke('accounts:autodetect', { email: addr }).catch(() => null)
      ])
      setPresets(list)
      const domain = addr.split('@')[1]?.toLowerCase() ?? ''
      const byId = guess?.provider ? list.find((p) => p.id === guess.provider) : undefined
      const byDomain = list.find((p) => p.domains.some((d) => d.toLowerCase() === domain))
      const chosen = byId ?? byDomain ?? list.find((p) => p.id === 'imap') ?? list[0]
      if (chosen) applyPreset(chosen)
      if (guess?.imap) setImap(guess.imap)
      if (guess?.smtp) setSmtp(guess.smtp)
      setUsername((u) => u || addr)
      setDetectedOnce(true)
    } finally {
      setDetecting(false)
    }
  }, [email, presets, applyPreset])

  // ------------------------------------------------------------------ oauth

  const oauthProvider = preset?.oauthProvider
  const clientConfig = oauthProvider ? settings?.oauthClients?.[oauthProvider] : undefined
  const oauthConfigured = Boolean(oauthProvider && clientConfig?.clientId)
  const supportsOauth = Boolean(preset?.authTypes.includes('oauth2') && oauthProvider)
  const supportsPassword = preset?.authTypes.includes('password') !== false
  const usingOauth = supportsOauth && oauthConfigured && !useAppPassword

  useEffect(() => {
    if (!oauthRunning) return
    return api.on('oauth:progress', (p) => {
      if (p.step === 'waitingForBrowser') {
        setOauthMessage(p.message ?? 'Waiting for you to finish in the browser…')
      } else if (p.step === 'exchanging') {
        setOauthMessage(p.message ?? 'Completing sign-in…')
      } else if (p.step === 'error') {
        setOauthMessage('')
        setOauthError(p.message ?? 'Sign-in failed.')
      } else {
        setOauthMessage('')
      }
    })
  }, [oauthRunning])

  const startOauth = useCallback(async () => {
    if (!oauthProvider || !clientConfig?.clientId) return
    setOauthRunning(true)
    setOauthError('')
    setOauthMessage('Opening your browser…')
    try {
      const res = await api.invoke('auth:oauthStart', {
        provider: oauthProvider,
        clientId: clientConfig.clientId,
        clientSecret: clientConfig.clientSecret,
        email: email.trim() || undefined
      })
      if (res.ok && res.tokens) {
        setOauth(res.tokens)
        const resolved = res.email ?? res.tokens.email
        if (resolved) {
          setEmail(resolved)
          setUsername((u) => u || resolved)
        }
        setOauthMessage('')
      } else {
        setOauthError(res.error || 'Sign-in was not completed.')
      }
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setOauthRunning(false)
    }
  }, [oauthProvider, clientConfig, email])

  const cancelOauth = useCallback(() => {
    void api.invoke('auth:oauthCancel', undefined).catch(() => undefined)
    setOauthRunning(false)
    setOauthMessage('')
  }, [])

  // ------------------------------------------------------------------ build

  const buildInput = useCallback((): AccountInput => {
    const addr = email.trim()
    return {
      email: addr,
      name: name.trim() || addr,
      provider: (presetId || 'imap') as ProviderId,
      authType: usingOauth ? 'oauth2' : 'password',
      imap,
      smtp,
      username: username.trim() || addr,
      password: password || undefined,
      oauth,
      color,
      signature: signature.trim() || undefined,
      cacheLimit: preset?.cacheLimit
    }
  }, [email, name, presetId, usingOauth, imap, smtp, username, password, oauth, color, signature, preset])

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.invoke('accounts:test', buildInput()))
    } catch (err) {
      setTestResult({
        ok: false,
        imap: { ok: false, error: err instanceof Error ? err.message : 'Test failed' },
        smtp: { ok: false, error: err instanceof Error ? err.message : 'Test failed' }
      })
    } finally {
      setTesting(false)
    }
  }, [buildInput])

  const save = useCallback(async () => {
    setSaving(true)
    setSaveError('')
    try {
      const input = buildInput()
      if (editing && account) {
        const patch: Partial<AccountInput> = { ...input }
        // Never overwrite stored secrets with blanks.
        if (!password) delete patch.password
        if (!oauth) delete patch.oauth
        const updated = await api.invoke('accounts:update', { id: account.id, patch })
        toast.success(`${updated.email} updated`)
        onSaved(updated)
      } else {
        const created = await api.invoke('accounts:add', input)
        toast.success(`${created.email} added`)
        onSaved(created)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The account could not be saved.')
    } finally {
      setSaving(false)
    }
  }, [buildInput, editing, account, password, oauth, toast, onSaved])

  // ------------------------------------------------------------- validation

  const emailValid = EMAIL_RE.test(email.trim())
  const canLeaveStep0 = emailValid && presetId !== ''
  const canLeaveStep1 =
    (usingOauth && (oauth != null || editing)) ||
    (!usingOauth && (password.trim().length > 0 || editing))
  const canLeaveStep2 = imap.host.trim().length > 0 && smtp.host.trim().length > 0

  const canContinue = step === 0 ? canLeaveStep0 : step === 1 ? canLeaveStep1 : canLeaveStep2

  const goNext = useCallback(async () => {
    if (step === 0) {
      if (!detectedOnce) await detect()
      setStep(1)
      return
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }, [step, detectedOnce, detect])

  if (!open) return null

  // -------------------------------------------------------------------- view

  const presetCards = PROVIDER_ORDER.map((id) => presets.find((p) => p.id === id)).filter(
    (p): p is ProviderPreset => p != null
  )

  return (
    <Modal
      open={open}
      size="lg"
      title={editing ? `Edit ${account?.email}` : 'Add an account'}
      onClose={onClose}
      closeOnBackdrop={false}
      footer={
        <div className="ac-wizard-foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="ac-wizard-foot-right">
            {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>Back</Button>}
            {step < STEPS.length - 1 ? (
              <Button
                variant="primary"
                loading={detecting}
                disabled={!canContinue}
                onClick={() => void goNext()}
              >
                Continue
              </Button>
            ) : (
              <Button variant="primary" loading={saving} onClick={() => void save()}>
                {editing ? 'Save changes' : 'Add account'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <Stepper steps={STEPS} current={step} />

      {step === 0 && (
        <div className="ac-step">
          <Input
            label="Email address"
            value={email}
            autoFocus={!editing}
            placeholder="you@example.com"
            spellCheck={false}
            error={email.trim() && !emailValid ? 'That does not look like an email address.' : undefined}
            onChange={(e) => setEmail(e.currentTarget.value)}
            onBlur={() => void detect()}
          />
          <Input
            label="Display name"
            hint="Shown as the sender name on messages you send."
            value={name}
            placeholder="Your name"
            onChange={(e) => setName(e.currentTarget.value)}
          />

          <div className="ac-provider-head">
            <span>Provider</span>
            {detecting && <Spinner size={13} label="Detecting" />}
          </div>
          <div className="ac-providers" role="radiogroup" aria-label="Provider">
            {presetCards.length === 0 && !detecting && (
              <p className="ac-hint">Enter your address to detect the provider.</p>
            )}
            {presetCards.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={presetId === p.id}
                className={`ac-provider ${presetId === p.id ? 'is-selected' : ''}`}
                onClick={() => applyPreset(p)}
              >
                <span className="ac-provider-name">{p.label || PROVIDER_LABEL[p.id]}</span>
                <span className="ac-provider-sub">
                  {p.authTypes.includes('oauth2')
                    ? p.authTypes.includes('password')
                      ? 'Sign in with Google or app password'
                      : 'Sign in with Microsoft'
                    : 'Password'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="ac-step">
          {usingOauth ? (
            <div className="ac-oauth">
              {oauth ? (
                <div className="ac-oauth-done">
                  <span className="ac-ok">✓</span>
                  <span>
                    Signed in{oauth.email ? ` as ${oauth.email}` : ''}. Continue to check the server
                    settings.
                  </span>
                </div>
              ) : oauthRunning ? (
                <div className="ac-oauth-running">
                  <Spinner size={16} />
                  <span>{oauthMessage || 'Waiting for you to finish in the browser…'}</span>
                  <Button size="sm" onClick={cancelOauth}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="primary" onClick={() => void startOauth()}>
                  {oauthProvider ? OAUTH_LABEL[oauthProvider] : 'Sign in'}
                </Button>
              )}
              {oauthError && <div className="ac-error-box">{oauthError}</div>}
              {editing && !oauth && (
                <p className="ac-hint">
                  This account is already signed in. Sign in again only if it stopped working.
                </p>
              )}
              {supportsPassword && (
                <div className="ac-alt">
                  <Toggle
                    checked={useAppPassword}
                    label="Use an app password instead"
                    onChange={setUseAppPassword}
                  />
                </div>
              )}
            </div>
          ) : supportsOauth && !oauthConfigured ? (
            <div className="ac-notice">
              <p className="ac-notice-title">
                {oauthProvider === 'google' ? 'Google' : 'Microsoft'} sign-in is not set up yet
              </p>
              <p>
                UniMail needs your own OAuth client id before it can sign you in. Add one in
                <strong> Settings › Connected apps</strong>, then come back here.
              </p>
              {preset?.id === 'gmail' && (
                <div className="ac-alt">
                  <Toggle
                    checked={useAppPassword}
                    label="Use an app password instead"
                    onChange={setUseAppPassword}
                  />
                </div>
              )}
              {preset?.id !== 'gmail' && supportsPassword && (
                <div className="ac-alt">
                  <Toggle
                    checked={useAppPassword}
                    label="Use a password instead"
                    onChange={setUseAppPassword}
                  />
                </div>
              )}
            </div>
          ) : null}

          {!usingOauth && (
            <>
              <Input
                label={preset?.id === 'imap' ? 'Password' : 'App password'}
                type="password"
                autoComplete="off"
                value={password}
                placeholder={editing ? 'Leave blank to keep the saved password' : ''}
                hint={
                  editing
                    ? 'Leave blank to keep the password already stored.'
                    : preset?.help ?? 'Most providers require an app-specific password rather than your normal one.'
                }
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
              {preset?.helpUrl && (
                <Button
                  size="sm"
                  onClick={() =>
                    void api
                      .invoke('app:openExternal', { url: preset.helpUrl as string })
                      .catch(() => undefined)
                  }
                >
                  How to create an app password
                </Button>
              )}
              {supportsOauth && oauthConfigured && (
                <div className="ac-alt">
                  <Toggle
                    checked={!useAppPassword}
                    label={oauthProvider ? OAUTH_LABEL[oauthProvider] : 'Use OAuth'}
                    onChange={(v) => setUseAppPassword(!v)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="ac-step">
          <p className="ac-servers-summary">
            Incoming <strong>{imap.host || 'not set'}:{imap.port}</strong> · Outgoing{' '}
            <strong>{smtp.host || 'not set'}:{smtp.port}</strong>
          </p>
          <p className="ac-hint">
            These came from the provider preset. Change them only if your host is different.
          </p>

          <Collapsible summary="Advanced" defaultOpen={!imap.host || !smtp.host}>
            <div className="ac-servers">
              <div className="ac-server-group">
                <h4>Incoming (IMAP)</h4>
                <Input
                  label="Host"
                  value={imap.host}
                  spellCheck={false}
                  onChange={(e) => setImap({ ...imap, host: e.currentTarget.value })}
                />
                <div className="ac-server-row">
                  <Input
                    label="Port"
                    type="number"
                    value={String(imap.port)}
                    onChange={(e) => setImap({ ...imap, port: Number(e.currentTarget.value) || 0 })}
                  />
                  <Select
                    label="Security"
                    value={imap.secure ? 'tls' : 'starttls'}
                    options={[
                      { value: 'tls', label: 'SSL/TLS' },
                      { value: 'starttls', label: 'STARTTLS / none' }
                    ]}
                    onChange={(e) => setImap({ ...imap, secure: e.currentTarget.value === 'tls' })}
                  />
                </div>
              </div>

              <div className="ac-server-group">
                <h4>Outgoing (SMTP)</h4>
                <Input
                  label="Host"
                  value={smtp.host}
                  spellCheck={false}
                  onChange={(e) => setSmtp({ ...smtp, host: e.currentTarget.value })}
                />
                <div className="ac-server-row">
                  <Input
                    label="Port"
                    type="number"
                    value={String(smtp.port)}
                    onChange={(e) => setSmtp({ ...smtp, port: Number(e.currentTarget.value) || 0 })}
                  />
                  <Select
                    label="Security"
                    value={smtp.secure ? 'tls' : 'starttls'}
                    options={[
                      { value: 'tls', label: 'SSL/TLS' },
                      { value: 'starttls', label: 'STARTTLS / none' }
                    ]}
                    onChange={(e) => setSmtp({ ...smtp, secure: e.currentTarget.value === 'tls' })}
                  />
                </div>
              </div>

              <Input
                label="Username"
                hint="Only change this if your server expects something other than your address."
                value={username}
                spellCheck={false}
                onChange={(e) => setUsername(e.currentTarget.value)}
              />
            </div>
          </Collapsible>
        </div>
      )}

      {step === 3 && (
        <div className="ac-step">
          <div className="ac-test-head">
            <Button loading={testing} onClick={() => void runTest()}>
              Test connection
            </Button>
            {editing && !password && !oauth && (
              <span className="ac-hint">Testing uses the credentials already stored.</span>
            )}
          </div>

          {testResult && (
            <ul className="ac-test-results">
              <li className={testResult.imap.ok ? 'is-ok' : 'is-bad'}>
                <span className="ac-test-mark">{testResult.imap.ok ? '✓' : '✗'}</span>
                <span className="ac-test-name">IMAP</span>
                <span className="ac-test-detail">
                  {testResult.imap.ok ? 'Connected' : testResult.imap.error || 'Failed'}
                </span>
              </li>
              <li className={testResult.smtp.ok ? 'is-ok' : 'is-bad'}>
                <span className="ac-test-mark">{testResult.smtp.ok ? '✓' : '✗'}</span>
                <span className="ac-test-name">SMTP</span>
                <span className="ac-test-detail">
                  {testResult.smtp.ok ? 'Connected' : testResult.smtp.error || 'Failed'}
                </span>
              </li>
            </ul>
          )}

          <div className="ac-color-field">
            <span className="ac-color-label">Account colour</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {saveError && <div className="ac-error-box">{saveError}</div>}
        </div>
      )}
    </Modal>
  )
}

export default AccountWizard
