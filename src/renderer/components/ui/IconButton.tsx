import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { forwardRef } from 'react'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'title'> {
  /** Required: used as both the tooltip and the accessible name. */
  title: string
  children: ReactNode
  size?: 'sm' | 'md'
  active?: boolean
  tone?: 'default' | 'danger' | 'star'
  className?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { title, children, size = 'md', active = false, tone = 'default', className, type = 'button', ...rest },
  ref
): ReactElement {
  const cls = [
    'ui-iconbtn',
    size === 'sm' ? 'ui-iconbtn--sm' : '',
    active ? 'ui-iconbtn--active' : '',
    tone === 'danger' ? 'ui-iconbtn--danger' : '',
    tone === 'star' ? 'ui-iconbtn--star' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button ref={ref} type={type} className={cls} title={title} aria-label={title} aria-pressed={active || undefined} {...rest}>
      {children}
    </button>
  )
})
