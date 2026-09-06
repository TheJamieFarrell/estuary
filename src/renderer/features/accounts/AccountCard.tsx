/**
 * One row in the accounts list: colour, identity, provider badge, live sync state and the
 * per-account actions. Reconnect only appears when OAuth actually needs re-authorising.
 */
import type { Account, AccountAuthErrorEvent, ProviderId, SyncStatus } from '@shared/types'
import { relativeDate } from '@renderer/lib/format'
import { Button, Spinner } from '@renderer/features/common-local/ui'

const PROVIDER_LABEL: Record<ProviderId, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  spacemail: 'Spacemail',
  icloud: 'iCloud',
  yahoo: 'Yahoo',
  fastmail: 'Fastmail',
  imap: 'IMAP'
}

const STATE_LABEL: Record<SyncStatus['state'], string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  listening: 'Up to date',
  error: 'Error',
  offline: 'Offline',
  disabled: 'Disabled'
}

export interface AccountCardProps {
  account: Account
  status?: SyncStatus
  authError?: AccountAuthErrorEvent
  syncing?: boolean
  onEdit: () => void
  onReconnect: () => void
  onSyncNow: () => void
  onRemove: () => void
}

export function AccountCard({
  account,
  status,
  authError,
  syncing = false,
  onEdit,
  onReconnect,
  onSyncNow,
  onRemove
}: AccountCardProps): React.JSX.Element {
  const state = account.enabled ? (status?.state ?? 'idle') : 'disabled'
  const busy = state === 'syncing' || state === 'connecting'
  const errorText = authError?.message ?? status?.error ?? account.lastError
  const needsReauth = authError?.needsReauth === true && account.authType === 'oauth2'
  const lastSync = status?.lastSyncAt ?? account.lastSyncAt

  return (
    <li className="ac-card">
      <span className="ac-swatch" style={{ background: account.color }} aria-hidden="true" />

      <div className="ac-identity">
        <div className="ac-name-line">
          <span className="ac-name">{account.name || account.email}</span>
          <span className="ac-badge">{PROVIDER_LABEL[account.provider] ?? account.provider}</span>
          {account.authType === 'oauth2' && <span className="ac-badge ac-badge--soft">OAuth</span>}
          {!account.enabled && <span className="ac-badge ac-badge--soft">Disabled</span>}
        </div>
        <div className="ac-email">{account.email}</div>

        <div className={`ac-state ac-state--${state}`}>
          {busy && <Spinner size={12} />}
          <span className="ac-state-text">{STATE_LABEL[state]}</span>
          {status?.detail && <span className="ac-state-detail">{status.detail}</span>}
          {lastSync != null && !busy && (
            <span className="ac-state-detail">Last synced {relativeDate(lastSync)}</span>
          )}
        </div>

        {errorText && (
          <div className="ac-error" role="status">
            {errorText}
          </div>
        )}
      </div>

      <div className="ac-actions">
        {needsReauth && (
          <Button variant="primary" size="sm" onClick={onReconnect}>
            Reconnect
          </Button>
        )}
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" loading={syncing} disabled={!account.enabled} onClick={onSyncNow}>
          Sync now
        </Button>
        <Button size="sm" variant="danger" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  )
}

export default AccountCard
export { PROVIDER_LABEL }
