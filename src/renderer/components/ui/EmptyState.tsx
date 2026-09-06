import type { ReactElement, ReactNode } from 'react'

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps): ReactElement {
  return (
    <div className={['ui-empty', className ?? ''].filter(Boolean).join(' ')}>
      {icon ? <div className="ui-empty__icon">{icon}</div> : null}
      <div className="ui-empty__title">{title}</div>
      {description ? <div className="ui-empty__desc">{description}</div> : null}
      {action}
    </div>
  )
}
