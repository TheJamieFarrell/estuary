import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react'
import { forwardRef, useId } from 'react'
import { ChevronDown } from '../icons'

interface FieldShellProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

/** Label + control + hint/error wrapper. Exported so feature forms can reuse the layout. */
export function Field({ label, hint, error, htmlFor, children, className }: FieldShellProps): ReactElement {
  return (
    <div className={['ui-field', className ?? ''].filter(Boolean).join(' ')}>
      {label ? (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? <span className="ui-field__error">{error}</span> : hint ? <span className="ui-field__hint">{hint}</span> : null}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, id, ...rest },
  ref
): ReactElement {
  const auto = useId()
  const inputId = id ?? auto
  const control = (
    <input
      ref={ref}
      id={inputId}
      className={['ui-input', error ? 'ui-input--invalid' : '', label ? '' : (className ?? '')].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  )
  if (!label && !hint && !error) return control
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      {control}
    </Field>
  )
})

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...rest },
  ref
): ReactElement {
  const auto = useId()
  const inputId = id ?? auto
  const control = (
    <textarea
      ref={ref}
      id={inputId}
      className={['ui-textarea', error ? 'ui-textarea--invalid' : '', label ? '' : (className ?? '')].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  )
  if (!label && !hint && !error) return control
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      {control}
    </Field>
  )
})

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  options?: SelectOption[]
  className?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, children, className, id, ...rest },
  ref
): ReactElement {
  const auto = useId()
  const inputId = id ?? auto
  const control = (
    <span className="ui-select-wrap">
      <select ref={ref} id={inputId} className="ui-select" {...rest}>
        {options ? options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        )) : children}
      </select>
      <ChevronDown size={14} />
    </span>
  )
  if (!label && !hint && !error) return control
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      {control}
    </Field>
  )
})
