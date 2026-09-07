/**
 * Email HTML sanitisation.
 *
 * Rules:
 *  - scripts / forms / iframes / objects are removed outright
 *  - author styling is kept (`style` attributes and `<style>` blocks) so mail looks like mail
 *  - links get target=_blank + rel=noopener noreferrer (the reader intercepts clicks anyway)
 *  - `cid:` images are rewritten to data: URLs via `attachments:inlineDataUrl`
 *  - remote images are blocked by moving `src` to `data-blocked-src` unless allowed
 */
import DOMPurify from 'dompurify'
import type { AttachmentMeta } from '@shared/types'
import { api } from './api'
import { escapeHtml, linkifyPlainText } from './format'

export interface SanitizeOptions {
  /** When false (default) remote http(s) images are stripped and counted. */
  allowRemoteImages?: boolean
}

export interface SanitizeResult {
  html: string
  /** Number of remote images that were blocked. */
  blockedImages: number
}

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'base',
  'link',
  'meta',
  'noscript'
]

const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'http-equiv', 'autoplay']

function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim())
}

/** Sync sanitiser. `cid:` images are marked with data-cid for a later async pass. */
export function sanitizeEmailHtml(dirty: string, opts: SanitizeOptions = {}): SanitizeResult {
  if (typeof window === 'undefined') return { html: '', blockedImages: 0 }
  let blocked = 0

  const hook = (node: Element): void => {
    const tag = node.tagName?.toLowerCase()
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? ''
      if (/^\s*javascript:/i.test(href)) node.removeAttribute('href')
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') ?? ''
      if (/^cid:/i.test(src)) {
        node.setAttribute('data-cid', src.slice(4).replace(/^<|>$/g, ''))
        node.removeAttribute('src')
      } else if (isRemote(src) && !opts.allowRemoteImages) {
        node.setAttribute('data-blocked-src', src)
        // A transparent pixel keeps the layout and avoids the browser's broken-image glyph.
        node.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
        blocked++
      }
    }
    // Legacy background="..." image attributes
    if (node.hasAttribute?.('background')) {
      const bg = node.getAttribute('background') ?? ''
      if (isRemote(bg) && !opts.allowRemoteImages) {
        node.setAttribute('data-blocked-background', bg)
        node.removeAttribute('background')
        blocked++
      }
    }
  }

  DOMPurify.addHook('afterSanitizeAttributes', hook)
  let clean = ''
  try {
    clean = DOMPurify.sanitize(dirty, {
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      ADD_TAGS: ['style'],
      ADD_ATTR: ['target', 'style', 'align', 'valign', 'bgcolor', 'background', 'width', 'height'],
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false
    }) as unknown as string
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }

  return { html: clean, blockedImages: blocked }
}

/** Replace `data-cid` placeholders with data: URLs fetched from the main process. */
export async function resolveCidImages(html: string, attachments: AttachmentMeta[]): Promise<string> {
  if (!html.includes('data-cid')) return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const imgs = Array.from(doc.querySelectorAll('img[data-cid]'))
  if (imgs.length === 0) return html

  const byCid = new Map<string, AttachmentMeta>()
  for (const a of attachments) {
    if (a.contentId) byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a)
    byCid.set(a.filename.toLowerCase(), a)
  }

  await Promise.all(
    imgs.map(async (img) => {
      const cid = (img.getAttribute('data-cid') ?? '').toLowerCase()
      const att = byCid.get(cid)
      if (!att) return
      try {
        const url = await api.invoke('attachments:inlineDataUrl', { attachmentId: att.id })
        if (url) img.setAttribute('src', url)
      } catch {
        /* leave the image unresolved */
      }
    })
  )

  return doc.body.firstElementChild?.innerHTML ?? html
}

/** Sanitise + resolve inline images in one pass. */
export async function prepareEmailHtml(
  dirty: string,
  attachments: AttachmentMeta[] = [],
  opts: SanitizeOptions = {}
): Promise<SanitizeResult> {
  const first = sanitizeEmailHtml(dirty, opts)
  const html = await resolveCidImages(first.html, attachments)
  return { html, blockedImages: first.blockedImages }
}

/** Re-enable previously blocked remote images (used by the "Show images" banner). */
export function unblockRemoteImages(html: string): string {
  return html
    .replace(/data-blocked-src=/g, 'src=')
    .replace(/data-blocked-background=/g, 'background=')
}

/** Wrap a plain-text body as HTML with clickable links. */
export function plainTextToHtml(text: string): string {
  return `<pre class="estuary-plain">${linkifyPlainText(text)}</pre>`
}

export interface FrameStyleOptions {
  fg: string
  bg: string
  muted: string
  link: string
  border: string
  fontFamily: string
  fontSize: string
  /** Applied to a dark theme so author-set light text stays readable on white blocks. */
  dark: boolean
}

/**
 * Build the `srcdoc` for the reader iframe: a strict CSP, a small base stylesheet
 * (author colours are preserved; only the page default fg/bg come from our tokens),
 * and the sanitised body.
 */
export function buildEmailSrcDoc(bodyHtml: string, style: FrameStyleOptions): string {
  const css = `
    :root { color-scheme: ${style.dark ? 'dark' : 'light'}; }
    html, body { margin: 0; padding: 0; }
    body {
      background: ${style.bg};
      color: ${style.fg};
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
      padding: 2px 0 8px;
    }
    img { max-width: 100%; height: auto; }
    img[data-blocked-src] {
      min-width: 12px; min-height: 12px;
      border: 1px dashed ${style.border};
      border-radius: 3px;
      background: ${style.muted}1a;
    }
    table { max-width: 100% !important; }
    pre, code { font-family: ui-monospace, Consolas, monospace; }
    pre.estuary-plain { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; font-size: inherit; }
    pre.estuary-plain .quote { color: ${style.muted}; }
    blockquote {
      margin: 8px 0; padding-left: 10px;
      border-left: 2px solid ${style.border};
      color: ${style.muted};
    }
    a { color: ${style.link}; }
    hr { border: none; border-top: 1px solid ${style.border}; }
    ${style.dark ? 'body [style*="color:#000"], body [style*="color: #000"], body [style*="color:black"] { color: inherit !important; }' : ''}
  `
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http: cid:; style-src 'unsafe-inline'; font-src data:;">
<style>${css}</style>
</head><body>${bodyHtml}</body></html>`
}

/** Small helper for showing raw source safely in a modal. */
export function rawToPre(raw: string): string {
  return `<pre>${escapeHtml(raw)}</pre>`
}
