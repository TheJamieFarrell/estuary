import type { ReactElement } from 'react'

interface LogoProps {
  size?: number
  /** Full-colour tile (default) or single-colour mark that follows `currentColor` */
  variant?: 'tile' | 'mono'
  className?: string
  title?: string
}

/**
 * The Estuary mark: a paper boat folded from a letter, level in the tide, with the E of
 * Estuary creased into its sail. Source of truth is docs/brand/estuary-mark*.svg; keep in sync.
 */
export function Logo({ size = 20, variant = 'tile', className, title = 'Estuary' }: LogoProps): ReactElement {
  if (variant === 'mono') {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" className={className} role="img" aria-label={title}>
        <path d="M44 30 L44 58 L24 58 Z" opacity=".75" />
        <path d="M50 10 L50 58 L86 58 Z M55 25 v3 h7 v-3 Z M55 37 v3 h15 v-3 Z M55 49 v3 h24 v-3 Z" fillRule="evenodd" />
        <path d="M8 62 H92 L86 74 H14 Z" />
        <path d="M0 84 C12 76 22 92 36 84 S60 76 72 84 S92 92 100 84" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
      </svg>
    )
  }
  const id = `estuary-${size}`
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#2f6fed" />
          <stop offset="1" stopColor="#0d2a72" />
        </linearGradient>
        <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#31d0c9" />
          <stop offset="1" stopColor="#0f8fb8" />
        </linearGradient>
        <linearGradient id={`${id}-deep`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0f8fb8" />
          <stop offset="1" stopColor="#0a4f8a" />
        </linearGradient>
        <clipPath id={`${id}-tile`}>
          <rect width="100" height="100" rx="22" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-tile)`}>
        <rect width="100" height="100" fill={`url(#${id}-sky)`} />
        <circle cx="82" cy="19" r="7.5" fill="#fff" opacity=".16" />
        <path d="M47 32 L47 58 L28 58 Z" fill="#dbe7ff" />
        <path d="M51 16 L51 58 L82 58 Z" fill="#fff" />
        <path d="M55 30 H61 M55 41 H68 M55 52 H76" stroke="#0d2a72" strokeWidth="2.4" strokeLinecap="round" opacity=".38" />
        <path d="M49 14 V60" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M14 60 H86 L78 76 H22 Z" fill="#fff" />
        <path d="M14 60 H86 L84 64 H16 Z" fill="#c9d8ff" opacity=".9" />
        <path d="M-4 70 C10 64 20 76 32 70 S54 64 66 70 S88 76 104 70 V104 H-4 Z" fill={`url(#${id}-sea)`} />
        <path d="M-4 70 C10 64 20 76 32 70 S54 64 66 70 S88 76 104 70" fill="none" stroke="#fff" strokeWidth="1.6" opacity=".55" />
        <path d="M-4 84 C10 78 20 90 32 84 S54 78 66 84 S88 90 104 84 V104 H-4 Z" fill={`url(#${id}-deep)`} opacity=".85" />
      </g>
    </svg>
  )
}
