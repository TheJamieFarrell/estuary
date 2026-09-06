import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageFull } from '@shared/types'
import { Button } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { api } from '@renderer/lib/api'
import { useResolvedTheme } from '@renderer/lib/hooks'
import { buildEmailSrcDoc, plainTextToHtml, prepareEmailHtml, unblockRemoteImages } from '@renderer/lib/sanitize'
import type { FrameStyleOptions } from '@renderer/lib/sanitize'
import './reader.css'

function readTokens(): FrameStyleOptions {
  const cs = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const v = (name: string, fallback: string): string => (cs?.getPropertyValue(name) || fallback).trim()
  return {
    fg: v('--fg', '#1b1f27'),
    bg: v('--bg-elev', '#ffffff'),
    muted: v('--fg-muted', '#5b6270'),
    link: v('--accent', '#2f6fed'),
    border: v('--border', '#e1e4ea'),
    fontFamily: v('--font-sans', 'system-ui, sans-serif'),
    fontSize: v('--fs-md', '13.5px'),
    dark: document.documentElement.dataset.theme === 'dark'
  }
}

export interface MessageBodyProps {
  message: MessageFull
  /** Global setting; a per-message override can still show images. */
  loadRemoteImages: boolean
}

/**
 * Renders the sanitised body inside a sandboxed iframe that auto-resizes to its content.
 * The iframe has no `allow-scripts`, so email JS can never run; we attach our own link
 * handler from the parent (same-origin srcdoc).
 */
export function MessageBody({ message, loadRemoteImages }: MessageBodyProps): ReactElement {
  const [showImages, setShowImages] = useState(loadRemoteImages)
  const [html, setHtml] = useState<string>('')
  const [blocked, setBlocked] = useState(0)
  const [height, setHeight] = useState(60)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resolvedTheme = useResolvedTheme()
  const theme = useMemo(readTokens, [resolvedTheme])

  useEffect(() => {
    setShowImages(loadRemoteImages)
  }, [loadRemoteImages, message.id])

  useEffect(() => {
    let cancelled = false
    async function run(): Promise<void> {
      if (message.html) {
        const res = await prepareEmailHtml(message.html, message.attachments, { allowRemoteImages: showImages })
        if (cancelled) return
        setHtml(res.html)
        setBlocked(res.blockedImages)
      } else {
        if (cancelled) return
        setHtml(plainTextToHtml(message.text ?? ''))
        setBlocked(0)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [message.id, message.html, message.text, message.attachments, showImages])

  const srcDoc = useMemo(() => buildEmailSrcDoc(html, theme), [html, theme])

  // Auto-resize + link handling
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let ro: ResizeObserver | undefined

    function measure(): void {
      const doc = frame?.contentDocument
      if (!doc?.body) return
      const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight)
      if (h > 0) setHeight(h + 8)
    }

    function onLoad(): void {
      const doc = frame?.contentDocument
      if (!doc?.body) return
      measure()
      // Use the frame's own ResizeObserver: observing a node from another realm can throw.
      try {
        const RO = (frame?.contentWindow as (Window & typeof globalThis) | null)?.ResizeObserver
        if (RO) {
          const observer = new RO(() => measure())
          observer.observe(doc.body)
          ro = observer
        }
      } catch {
        // fall back to the timed re-measures below
      }
      window.setTimeout(measure, 60)
      window.setTimeout(measure, 300)
      doc.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
        if (!target) return
        e.preventDefault()
        const href = target.getAttribute('href') ?? ''
        if (!href || href.startsWith('#')) return
        void api.invoke('app:openExternal', { url: href })
      })
      // Images finishing later change the height
      Array.from(doc.images).forEach((img) => img.addEventListener('load', measure))
    }

    frame.addEventListener('load', onLoad)
    if (frame.contentDocument?.readyState === 'complete') onLoad()
    return () => {
      frame.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [srcDoc])

  return (
    <>
      {blocked > 0 && !showImages ? (
        <div className="tv-images-banner">
          <Icons.Image size={15} />
          <span style={{ flex: 1 }}>
            {blocked === 1 ? '1 image was blocked' : `${blocked} images were blocked`} to protect your privacy
          </span>
          <Button size="sm" variant="secondary" onClick={() => setShowImages(true)}>
            Show images
          </Button>
        </div>
      ) : null}
      <div className="tv-message__body">
        <iframe
          ref={frameRef}
          className="tv-message__frame"
          title={`Message body: ${message.subject}`}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={showImages ? unblockRemoteImages(srcDoc) : srcDoc}
          style={{ height }}
        />
      </div>
    </>
  )
}
