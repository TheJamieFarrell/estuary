/**
 * Small generic React hooks used across renderer features.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Debounce a value. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return debounced
}

/** Stable callback identity that always sees the latest closure. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

/** Track a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Observe an element's size. Returns [ref, size]. */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number }
] {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const observer = useRef<ResizeObserver | null>(null)
  const setRef = useCallback((node: T | null) => {
    observer.current?.disconnect()
    if (!node) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ width: r.width, height: r.height })
    })
    ro.observe(node)
    observer.current = ro
    setSize({ width: node.clientWidth, height: node.clientHeight })
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  return [setRef, size]
}

/** The theme actually applied to <html> ('light' | 'dark'), tracked live. */
export function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const el = document.documentElement
    const read = (): void => setTheme(el.dataset.theme === 'dark' ? 'dark' : 'light')
    read()
    const mo = new MutationObserver(read)
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return theme
}

/** True while the browser reports the machine offline. */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = (): void => setOnline(true)
    const down = (): void => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** Run an effect on an interval, pausing when the tab is hidden. */
export function useInterval(fn: () => void, ms: number | null): void {
  const cb = useEvent(fn)
  useEffect(() => {
    if (ms === null) return
    const id = window.setInterval(() => {
      if (!document.hidden) cb()
    }, ms)
    return () => window.clearInterval(id)
  }, [ms, cb])
}

/** Focus an element once on mount. */
export function useAutoFocus<T extends HTMLElement>(enabled = true): (node: T | null) => void {
  return useCallback(
    (node: T | null) => {
      if (node && enabled) window.setTimeout(() => node.focus(), 0)
    },
    [enabled]
  )
}

/** Previous render's value. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}

export interface WindowRange {
  start: number
  end: number
  offsetTop: number
  totalHeight: number
}

/**
 * Minimal fixed-row-height windowing (no dependency).
 * Feed it the scroll container ref's scrollTop/height and it returns the visible slice.
 */
export function useVirtualWindow(
  itemCount: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 6
): WindowRange {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visible = Math.ceil((viewportHeight || 600) / rowHeight) + overscan * 2
  const end = Math.min(itemCount, start + visible)
  return { start, end, offsetTop: start * rowHeight, totalHeight: itemCount * rowHeight }
}

/**
 * Scroll position of a container element, throttled to animation frames.
 * Takes the element itself (not a ref) so it re-subscribes when the node changes —
 * a ref's `.current` is not a reactive dependency.
 */
export function useScrollTop(el: HTMLElement | null): number {
  const [top, setTop] = useState(0)
  useEffect(() => {
    if (!el) return
    let raf = 0
    const onScroll = (): void => {
      // rAF never fires while the document is hidden; fall back to a direct update.
      if (document.hidden) {
        setTop(el.scrollTop)
        return
      }
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [el])
  return top
}
