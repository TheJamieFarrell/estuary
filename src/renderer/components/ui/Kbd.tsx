import type { ReactElement } from 'react'

export interface KbdProps {
  children: string
  className?: string
}

/** Renders a key or key sequence: "Ctrl+N", "g i", "?" */
export function Kbd({ children, className }: KbdProps): ReactElement {
  const parts = children.split(/(?<=\S)\s+(?=\S)/)
  return (
    <span className={['ui-kbd-group', className ?? ''].filter(Boolean).join(' ')} style={{ display: 'inline-flex', gap: 3 }}>
      {parts.map((p, i) =>
        parts.length > 1 && (p === '/' || p === 'or') ? (
          <span key={i} style={{ color: 'var(--fg-faint)' }}>
            {p === '/' ? 'or' : p}
          </span>
        ) : (
          <kbd key={i} className="ui-kbd">
            {p}
          </kbd>
        )
      )}
    </span>
  )
}
