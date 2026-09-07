import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'
import { Close } from '../icons'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** Hide the header close button (Esc still closes) */
  hideClose?: boolean
  /** Clicking the backdrop closes. Default true. */
  closeOnBackdrop?: boolean
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  hideClose,
  closeOnBackdrop = true
}: ModalProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  // Callers usually pass an inline `onClose`, so keep the latest one in a ref: the focus/keyboard
  // effect below must run only when the modal opens, never on every parent re-render (that used
  // to yank focus to the close button while the user was typing).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab' && ref.current) {
        const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (n) => n.offsetParent !== null || n === document.activeElement
        )
        if (nodes.length === 0) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    [open]
  )

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeyDown, true)
    const t = window.setTimeout(() => {
      // Only steal focus if nothing inside the dialog has it yet.
      if (ref.current?.contains(document.activeElement)) return
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      // Prefer the first text field over the header close button.
      const node = nodes.find((n) => n.matches('input,textarea,select')) ?? nodes[0]
      if (node) node.focus()
      else ref.current?.focus()
    }, 0)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.clearTimeout(t)
      restoreTo.current?.focus?.()
    }
  }, [open, onKeyDown])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="ui-modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`ui-modal ui-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        ref={ref}
        tabIndex={-1}
      >
        {title || !hideClose ? (
          <div className="ui-modal__head">
            {title ? <h2 className="ui-modal__title">{title}</h2> : <span style={{ flex: 1 }} />}
            {hideClose ? null : (
              <IconButton title="Close" onClick={onClose}>
                <Close />
              </IconButton>
            )}
          </div>
        ) : null}
        <div className="ui-modal__body">{children}</div>
        {footer ? <div className="ui-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
