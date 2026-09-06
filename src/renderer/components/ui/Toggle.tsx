import type { ChangeEvent, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'
import { Check } from '../icons'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  id?: string
  /** Accessible name when there is no visible label */
  title?: string
}

export function Toggle({ checked, onChange, label, disabled, id, title }: ToggleProps): ReactElement {
  return (
    <label className={['ui-toggle', disabled ? 'ui-toggle--disabled' : ''].filter(Boolean).join(' ')} title={title}>
      <input
        type="checkbox"
        role="switch"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={typeof label === 'string' ? label : title}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="ui-toggle__track">
        <span className="ui-toggle__thumb" />
      </span>
      {label ? <span className="ui-toggle__label">{label}</span> : null}
    </label>
  )
}

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean, event: ReactMouseEvent | ChangeEvent) => void
  label?: ReactNode
  disabled?: boolean
  id?: string
  title?: string
  className?: string
  /** Stop click bubbling (used inside clickable list rows) */
  stopPropagation?: boolean
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  id,
  title,
  className,
  stopPropagation
}: CheckboxProps): ReactElement {
  return (
    <label
      className={['ui-check', className ?? ''].filter(Boolean).join(' ')}
      title={title}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
    >
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={typeof label === 'string' ? label : title}
        onChange={(e) => onChange(e.currentTarget.checked, e)}
      />
      <span className="ui-check__box">
        <Check size={11} strokeWidth={3} />
      </span>
      {label ? <span className="ui-check__label">{label}</span> : null}
    </label>
  )
}
