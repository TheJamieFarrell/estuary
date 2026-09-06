import type { ReactElement, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  id?: string
  label?: ReactNode
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Renders a divider; other fields ignored */
  separator?: boolean
  /** Renders a non-interactive section heading */
  heading?: string
  checked?: boolean
  onSelect?: () => void
}

export interface MenuProps {
  items: MenuItem[]
  /** Element the menu is positioned against */
  anchorEl: HTMLElement | null
  onClose: () => void
  align?: 'left' | 'right'
  minWidth?: number
}

/** Low-level positioned menu. Most callers want <Dropdown/>. */
export function Menu({ items, anchorEl, onClose, align = 'left', minWidth }: MenuProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const selectable = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.separator && !it.heading && !it.disabled)

  useLayoutEffect(() => {
    if (!anchorEl || !ref.current) return
    const a = anchorEl.getBoundingClientRect()
    const m = ref.current.getBoundingClientRect()
    let left = align === 'right' ? a.right - m.width : a.left
    let top = a.bottom + 4
    if (left + m.width > window.innerWidth - 8) left = window.innerWidth - m.width - 8
    if (left < 8) left = 8
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 4)
    setPos({ top, left })
  }, [anchorEl, align, items.length])

  useEffect(() => {
    function onDocDown(e: MouseEvent): void {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (anchorEl?.contains(t)) return
      onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((cur) => {
          const order = selectable.map((s) => s.i)
          if (order.length === 0) return -1
          const at = order.indexOf(cur)
          const next = e.key === 'ArrowDown' ? at + 1 : at - 1
          return order[(next + order.length) % order.length]
        })
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault()
        const item = items[activeIndex]
        if (item && !item.disabled) {
          onClose()
          item.onSelect?.()
        }
      }
    }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchorEl, onClose, items, activeIndex, selectable])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={ref}
      className="ui-menu"
      role="menu"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        minWidth,
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      {items.map((item, i) => {
        if (item.separator) return <div key={item.id ?? `sep-${i}`} className="ui-menu__sep" role="separator" />
        if (item.heading)
          return (
            <div key={item.id ?? `head-${i}`} className="ui-menu__heading">
              {item.heading}
            </div>
          )
        return (
          <button
            key={item.id ?? `item-${i}`}
            type="button"
            role="menuitem"
            className={['ui-menu__item', item.danger ? 'ui-menu__item--danger' : ''].filter(Boolean).join(' ')}
            data-active={activeIndex === i}
            disabled={item.disabled}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            {item.icon !== undefined || item.checked !== undefined ? (
              <span className="ui-menu__icon">{item.checked ? '✓' : item.icon}</span>
            ) : null}
            <span className="ui-menu__label">{item.label}</span>
            {item.shortcut ? <span className="ui-menu__shortcut">{item.shortcut}</span> : null}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

export interface DropdownProps {
  /** Anchor content; clicking it toggles the menu. */
  trigger: ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  minWidth?: number
  className?: string
}

export function Dropdown({ trigger, items, align = 'left', minWidth, className }: DropdownProps): ReactElement {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      <span
        ref={anchor}
        className={['ui-menu-anchor', className ?? ''].filter(Boolean).join(' ')}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </span>
      {open ? (
        <Menu items={items} anchorEl={anchor.current} align={align} minWidth={minWidth} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}
