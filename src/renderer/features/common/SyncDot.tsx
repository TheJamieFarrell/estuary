import type { ReactElement } from 'react'
import type { SyncState, SyncStatus } from '@shared/types'
import './common.css'

const LABELS: Record<SyncState, string> = {
  idle: 'Up to date',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  listening: 'Connected',
  error: 'Connection problem',
  offline: 'Offline',
  disabled: 'Account disabled'
}

export interface SyncDotProps {
  status?: SyncStatus
  className?: string
}

export function syncLabel(status?: SyncStatus): string {
  if (!status) return 'Not connected'
  const base = LABELS[status.state] ?? status.state
  if (status.state === 'error' && status.error) return `${base}: ${status.error}`
  return status.detail ? `${base} — ${status.detail}` : base
}

export function SyncDot({ status, className }: SyncDotProps): ReactElement {
  const state: SyncState = status?.state ?? 'idle'
  return (
    <span
      className={['cm-syncdot', `cm-syncdot--${state}`, className ?? ''].filter(Boolean).join(' ')}
      title={syncLabel(status)}
      role="img"
      aria-label={syncLabel(status)}
    />
  )
}
