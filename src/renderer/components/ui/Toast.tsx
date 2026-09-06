import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'
import { Close } from '../icons'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastOptions {
  title?: string
  message?: ReactNode
  kind?: ToastKind
  /** ms; 0 keeps it until dismissed. Default 4500 (7000 for errors). */
  duration?: number
  action?: { label: string; onClick: () => void }
}

interface ToastRecord extends ToastOptions {
  id: number
}

export interface ToastApi {
  show: (opts: ToastOptions) => number
  info: (message: ReactNode, title?: string) => number
  success: (message: ReactNode, title?: string) => number
  error: (message: ReactNode, title?: string) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (ctx) return ctx
  // Fallback so components used outside the provider (e.g. compose window) never crash.
  return {
    show: () => 0,
    info: () => 0,
    success: () => 0,
    error: (m) => {
      console.error('[toast]', m)
      return 0
    },
    dismiss: () => undefined
  }
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const seq = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(
    (opts: ToastOptions) => {
      const id = seq.current++
      const rec: ToastRecord = { ...opts, id }
      setToasts((cur) => [...cur.slice(-4), rec])
      const duration = opts.duration ?? (opts.kind === 'error' ? 7000 : 4500)
      if (duration > 0) window.setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss]
  )

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      info: (message, title) => show({ message, title, kind: 'info' }),
      success: (message, title) => show({ message, title, kind: 'success' }),
      error: (message, title) => show({ message, title, kind: 'error' })
    }),
    [show, dismiss]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            <div className="ui-toasts" role="region" aria-label="Notifications">
              {toasts.map((t) => (
                <div key={t.id} className={`ui-toast ui-toast--${t.kind ?? 'info'}`} role="status">
                  <div className="ui-toast__body">
                    {t.title ? <div className="ui-toast__title">{t.title}</div> : null}
                    {t.message ? <div className="ui-toast__msg">{t.message}</div> : null}
                    {t.action ? (
                      <div className="ui-toast__action">
                        <button
                          type="button"
                          className="ui-btn ui-btn--ghost ui-btn--sm"
                          onClick={() => {
                            dismiss(t.id)
                            t.action?.onClick()
                          }}
                        >
                          {t.action.label}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <IconButton title="Dismiss" size="sm" onClick={() => dismiss(t.id)}>
                    <Close size={13} />
                  </IconButton>
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </ToastContext.Provider>
  )
}
