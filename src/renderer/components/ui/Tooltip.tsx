import type { ReactElement, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface TooltipProps {
  label: ReactNode
  children: ReactNode
  placement?: 'top' | 'bottom'
  delay?: number
}

export function Tooltip({ label, children, placement = 'bottom', delay = 350 }: TooltipProps): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<number>(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  function open(): void {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      setPos({
        top: placement === 'top' ? r.top - 26 : r.bottom + 6,
        left: Math.min(Math.max(8, r.left), window.innerWidth - 200)
      })
    }, delay)
  }
  function close(): void {
    window.clearTimeout(timer.current)
    setPos(null)
  }

  return (
    <>
      <span
        ref={anchor}
        className="ui-tooltip-anchor"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </span>
      {pos && typeof document !== 'undefined'
        ? createPortal(
            <div className="ui-tooltip" role="tooltip" style={{ top: pos.top, left: pos.left }}>
              {label}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
