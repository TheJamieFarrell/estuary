import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  block?: boolean
  icon?: ReactNode
  className?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, block = false, icon, children, disabled, className, type = 'button', ...rest },
  ref
): ReactElement {
  const cls = [
    'ui-btn',
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    block ? 'ui-btn--block' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      <span className={loading ? 'ui-btn__label--hidden' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {icon}
        {children}
      </span>
      {loading ? (
        <span className="ui-btn__spinner">
          <Spinner size={size === 'sm' ? 12 : 14} />
        </span>
      ) : null}
    </button>
  )
})
