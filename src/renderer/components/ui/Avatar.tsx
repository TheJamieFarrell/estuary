import type { ReactElement } from 'react'
import { initialsFor } from '@renderer/lib/format'

const PALETTE = [
  '#c2410c', '#b45309', '#4d7c0f', '#047857', '#0e7490',
  '#1d4ed8', '#4f46e5', '#7e22ce', '#a21caf', '#be123c',
  '#0f766e', '#3f6212'
]

/** Deterministic colour from an email address (stable across sessions). */
export function colorForAddress(address: string): string {
  let h = 0
  const s = (address || '?').toLowerCase()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export interface AvatarProps {
  /** Email address; drives the deterministic colour and the fallback initials */
  address?: string
  /** Display name, preferred for initials */
  name?: string
  size?: number
  /** Override colour (e.g. the account colour) */
  color?: string
  square?: boolean
  title?: string
  className?: string
}

export function Avatar({ address = '', name, size = 32, color, square, title, className }: AvatarProps): ReactElement {
  const bg = color ?? colorForAddress(address)
  const initials = initialsFor(name, address)
  return (
    <span
      className={['ui-avatar', square ? 'ui-avatar--square' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size, background: bg, fontSize: Math.max(9, Math.round(size * 0.4)) }}
      title={title ?? (name ? `${name} <${address}>` : address)}
      aria-hidden={title ? undefined : true}
    >
      {initials}
    </span>
  )
}
