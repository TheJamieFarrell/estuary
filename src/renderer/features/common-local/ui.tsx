/**
 * Adapter over the shared UI kit for the compose / settings / accounts screens.
 *
 * Everything the kit provides is re-exported unchanged; this file only adds the handful of
 * pieces the kit does not have (confirm dialog, section/row layout, collapsible, colour
 * palette picker, wizard stepper).
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@renderer/components/ui'
import './ui.css'

export {
  Button,
  IconButton,
  Field,
  Input,
  Textarea,
  Select,
  Toggle,
  Checkbox,
  Modal,
  Menu,
  Dropdown,
  ToastProvider,
  useToast,
  Spinner,
  Avatar,
  Chip,
  Tooltip,
  EmptyState,
  Kbd,
  colorForAddress
} from '@renderer/components/ui'
export type {
  ButtonProps,
  ButtonVariant,
  ButtonSize,
  IconButtonProps,
  InputProps,
  TextareaProps,
  SelectProps,
  SelectOption,
  ToggleProps,
  CheckboxProps,
  ModalProps,
  MenuItem,
  MenuProps,
  DropdownProps,
  ToastApi,
  ToastOptions,
  ToastKind,
  SpinnerProps,
  AvatarProps,
  ChipProps,
  TooltipProps,
  EmptyStateProps,
  KbdProps
} from '@renderer/components/ui'

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element | null {
  if (!open) return null
  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="ul-confirm-message">{message}</div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Layout helpers (settings + accounts)
// ---------------------------------------------------------------------------

export function Row({
  label,
  description,
  children
}: {
  label: ReactNode
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="ul-row">
      <div className="ul-row-text">
        <div className="ul-row-label">{label}</div>
        {description != null && <div className="ul-row-desc">{description}</div>}
      </div>
      <div className="ul-row-control">{children}</div>
    </div>
  )
}

export function Section({
  title,
  description,
  children
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="ul-section">
      <header className="ul-section-head">
        <h2>{title}</h2>
        {description != null && <p>{description}</p>}
      </header>
      <div className="ul-section-body">{children}</div>
    </section>
  )
}

export function Collapsible({
  summary,
  children,
  defaultOpen = false
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  return (
    <details className="ul-collapsible" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="ul-collapsible-body">{children}</div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Colour palette (accounts)
// ---------------------------------------------------------------------------

/** Ten accent colours accounts are tinted with. */
export const ACCOUNT_COLORS = [
  '#2f6fed',
  '#e05252',
  '#2e9e5b',
  '#d98a1f',
  '#8b5cf6',
  '#0ea5a4',
  '#db2777',
  '#65a30d',
  '#f97316',
  '#64748b'
] as const

export function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (next: string) => void
}): React.JSX.Element {
  return (
    <div className="ul-colors" role="radiogroup" aria-label="Account colour">
      {ACCOUNT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          className={`ul-color ${value.toLowerCase() === c ? 'is-selected' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

/** First palette colour not already taken by an account. */
export function nextUnusedColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return ACCOUNT_COLORS.find((c) => !taken.has(c)) ?? ACCOUNT_COLORS[0]
}

// ---------------------------------------------------------------------------
// Stepper (account wizard)
// ---------------------------------------------------------------------------

export function Stepper({ steps, current }: { steps: string[]; current: number }): React.JSX.Element {
  return (
    <ol className="ul-stepper">
      {steps.map((s, i) => (
        <li
          key={s}
          className={`ul-step ${i === current ? 'is-current' : ''} ${i < current ? 'is-done' : ''}`}
        >
          <span className="ul-step-dot">{i < current ? '✓' : i + 1}</span>
          <span className="ul-step-label">{s}</span>
        </li>
      ))}
    </ol>
  )
}
