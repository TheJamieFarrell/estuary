import type { ReactElement, ReactNode } from 'react'
import { Close } from '../icons'

export interface ChipProps {
  children: ReactNode
  icon?: ReactNode
  active?: boolean
  onClick?: () => void
  onRemove?: () => void
  title?: string
  className?: string
}

export function Chip({ children, icon, active, onClick, onRemove, title, className }: ChipProps): ReactElement {
  const cls = ['ui-chip', active ? 'ui-chip--active' : '', className ?? ''].filter(Boolean).join(' ')
  const content = (
    <>
      {icon}
      <span className="ui-chip__label">{children}</span>
      {onRemove ? (
        <span
          className="ui-chip__remove"
          role="button"
          tabIndex={-1}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Close size={12} />
        </span>
      ) : null}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={cls} title={title} aria-pressed={active} onClick={onClick}>
        {content}
      </button>
    )
  }
  return (
    <span className={cls} title={title}>
      {content}
    </span>
  )
}
