import type { ReactElement } from 'react'

export interface SpinnerProps {
  size?: number
  className?: string
  /** Accessible label; omit inside a button that already has one */
  label?: string
}

export function Spinner({ size = 16, className, label }: SpinnerProps): ReactElement {
  return (
    <svg
      className={['ui-spinner', className ?? ''].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
