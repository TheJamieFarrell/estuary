/**
 * The compose window. Runs in its own BrowserWindow (`compose.html`) with a hidden title bar,
 * so the top 40px is a custom draggable header and the right ~140px stays clear for the
 * native window-control overlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ComposeAttachment, ComposePayload, EmailAddress } from '@shared/types'
import { api } from '@renderer/lib/api'
import { formatBytes } from '@renderer/lib/format'
import {
  Button,
  ConfirmDialog,
  IconButton,
  Spinner,
  useToast
} from '@renderer/features/common-local/ui'
import RecipientInput from './RecipientInput'
import ComposeEditor from './Editor'
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  SIGNATURE_CLASS,
  appendSignature,
  cidToDataUrls,
  dataUrlsToCid,
  fileToBase64,
  formatClock,
  htmlToText,
  isBodyEmpty,
  isValidAddress,
  joinQuote,
  mentionsAttachment,
  newContentId,
  replaceSignature,
  splitQuote,
  totalAttachmentBytes,
  windowTitleFor
} from './util'
import './compose.css'

const AUTOSAVE_MS = 30_000

const EMPTY_PAYLOAD: ComposePayload = {
  accountId: '',
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  html: '',
  attachments: [],
  mode: 'new'
}

interface PendingConfirm {
  title: string
  message: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

export function ComposeApp(): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [to, setTo] = useState<EmailAddress[]>([])
  const [cc, setCc] = useState<EmailAddress[]>([])
  const [bcc, setBcc] = useState<EmailAddress[]>([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [initialBody, setInitialBody] = useState('')
  const [quote, setQuote] = useState('')
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([])
  const [draftId, setDraftId] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<ComposePayload['mode']>('new')
  const [inReplyToMessageId, setInReplyToMessageId] = useState<string | undefined>(undefined)

  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [sending, setSending] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined)
  const [sendError, setSendError] = useState<string | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const toast = useToast()
  const dirty = useRef(false)
  const closing = useRef(false)
  const dragDepth = useRef(0)

  const enabledAccounts = useMemo(() => accounts.filter((a) => a.enabled), [accounts])
  const account = useMemo(
    () => accounts.find((a) => a.id === accountId),
    [accounts, accountId]
  )

  const markDirty = useCallback(() => {
    dirty.current = true
  }, [])

  // ---------------------------------------------------------------- init ----

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.invoke('compose:init', undefined)
        if (cancelled) return
        const p = res.payload ?? EMPTY_PAYLOAD
        const list = res.accounts ?? []
        setAccounts(list)
        const chosen =
          list.find((a) => a.id === p.accountId) ?? list.find((a) => a.enabled) ?? list[0]
        setAccountId(chosen?.id ?? p.accountId ?? '')
        setTo(p.to ?? [])
        setCc(p.cc ?? [])
        setBcc(p.bcc ?? [])
        setShowCc((p.cc ?? []).length > 0)
        setShowBcc((p.bcc ?? []).length > 0)
        setSubject(p.subject ?? '')
        setAttachments(p.attachments ?? [])
        setDraftId(p.draftId)
        setMode(p.mode ?? 'new')
        setInReplyToMessageId(p.inReplyToMessageId)

        const withImages = cidToDataUrls(p.html ?? '', p.attachments ?? [])
        const split = splitQuote(withImages)
        const withSig = appendSignature(split.body, chosen?.signature)
        setBody(withSig)
        setInitialBody(withSig)
        setQuote(split.quote)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not open the composer')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Runs once; toast identity is stable enough for a mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // main tells us the send completed and the window may go away
  useEffect(() => {
    return api.on('compose:close', () => {
      closing.current = true
      window.close()
    })
  }, [])

  // window title
  useEffect(() => {
    document.title = windowTitleFor(subject, mode)
  }, [subject, mode])

  // ------------------------------------------------------------ payload ----

  const buildPayload = useCallback((): ComposePayload => {
    const html = dataUrlsToCid(joinQuote(body, quote), attachments)
    return {
      draftId,
      accountId,
      to,
      cc,
      bcc,
      subject,
      html,
      text: htmlToText(html),
      attachments,
      inReplyToMessageId,
      mode
    }
  }, [body, quote, attachments, draftId, accountId, to, cc, bcc, subject, inReplyToMessageId, mode])

  const isEmpty = useCallback(
    () =>
      !to.length &&
      !cc.length &&
      !bcc.length &&
      !subject.trim() &&
      !attachments.length &&
      isBodyEmpty(body),
    [to, cc, bcc, subject, attachments, body]
  )

  // --------------------------------------------------------- draft saving ---

  const saveDraft = useCallback(
    async (silent: boolean): Promise<boolean> => {
      if (!accountId) return false
      if (silent && !dirty.current) return false
      if (silent && isEmpty()) return false
      setSavingDraft(true)
      try {
        const draft = await api.invoke('drafts:save', buildPayload())
        setDraftId(draft.id)
        setSavedAt(draft.updatedAt || Date.now())
        dirty.current = false
        return true
      } catch (err) {
        if (!silent) {
          toast.error(err instanceof Error ? err.message : 'Could not save the draft')
        }
        return false
      } finally {
        setSavingDraft(false)
      }
    },
    [accountId, buildPayload, isEmpty, toast]
  )

  // Keep the latest saveDraft reachable from the interval/blur handlers.
  const saveDraftRef = useRef(saveDraft)
  saveDraftRef.current = saveDraft

  useEffect(() => {
    const id = window.setInterval(() => {
      void saveDraftRef.current(true)
    }, AUTOSAVE_MS)
    const onBlur = (): void => {
      void saveDraftRef.current(true)
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ----------------------------------------------------------- from swap ----

  const onChangeAccount = useCallback(
    (nextId: string) => {
      const next = accounts.find((a) => a.id === nextId)
      setAccountId(nextId)
      markDirty()
      if (!next) return
      // Swap the old signature block if it is still there untouched; otherwise the user has
      // edited or deleted it and we only append when there is none at all.
      const swapped = body.includes(SIGNATURE_CLASS)
        ? replaceSignature(body, next.signature)
        : appendSignature(body, next.signature)
      if (swapped !== body) {
        setBody(swapped)
        setInitialBody(swapped)
      }
    },
    [accounts, body, markDirty]
  )

  // --------------------------------------------------------- attachments ----

  const addAttachments = useCallback(
    (incoming: ComposeAttachment[]) => {
      if (!incoming.length) return
      setAttachments((prev) => {
        const next = [...prev, ...incoming]
        if (totalAttachmentBytes(next) > MAX_TOTAL_ATTACHMENT_BYTES) {
          toast.show({
            kind: 'error',
            title: 'Attachments are large',
            message: `${formatBytes(totalAttachmentBytes(next))} total. Most servers reject messages over 25 MB.`
          })
        }
        return next
      })
      markDirty()
    },
    [markDirty, toast]
  )

  const pickFiles = useCallback(async () => {
    try {
      const files = await api.invoke('compose:pickFiles', undefined)
      addAttachments(
        files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          path: f.path,
          size: f.size
        }))
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not attach the files')
    }
  }, [addAttachments, toast])

  /** Dropped files have no usable `path` in a sandboxed renderer, so read them into base64. */
  const addDroppedFiles = useCallback(
    async (files: File[]) => {
      const built: ComposeAttachment[] = []
      for (const file of files) {
        try {
          built.push({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            contentBase64: await fileToBase64(file),
            size: file.size
          })
        } catch {
          toast.error(`Could not read ${file.name}`)
        }
      }
      addAttachments(built)
    },
    [addAttachments, toast]
  )

  const removeAttachment = useCallback(
    (index: number) => {
      setAttachments((prev) => prev.filter((_, i) => i !== index))
      markDirty()
    },
    [markDirty]
  )

  /** Pasted images become inline attachments with a contentId; the editor shows the data URL. */
  const onPasteImage = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const base64 = await fileToBase64(file)
        const contentId = newContentId()
        const contentType = file.type || 'image/png'
        setAttachments((prev) => [
          ...prev,
          {
            filename: file.name || `pasted-image.${contentType.split('/')[1] ?? 'png'}`,
            contentType,
            contentBase64: base64,
            contentId,
            size: file.size
          }
        ])
        markDirty()
        return `data:${contentType};base64,${base64}`
      } catch {
        toast.error('Could not read the pasted image')
        return null
      }
    },
    [markDirty, toast]
  )

  // drag and drop over the whole window
  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
      e.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent): void => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      void addDroppedFiles(files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addDroppedFiles])

  // ---------------------------------------------------------------- send ----

  const doSend = useCallback(async () => {
    setSending(true)
    setSendError(undefined)
    try {
      const res = await api.invoke('compose:send', buildPayload())
      if (res.ok) {
        dirty.current = false
        // main normally answers with a `compose:close` event; close ourselves if it does not.
        window.setTimeout(() => {
          if (!closing.current) window.close()
        }, 1200)
      } else {
        setSendError(res.error || 'The message could not be sent.')
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'The message could not be sent.')
    } finally {
      setSending(false)
    }
  }, [buildPayload])

  const onSend = useCallback(() => {
    setSendError(undefined)
    const recipients = [...to, ...cc, ...bcc]
    if (!recipients.length) {
      setSendError('Add at least one recipient.')
      return
    }
    const invalid = recipients.filter((r) => !isValidAddress(r.address))
    if (invalid.length) {
      setSendError(
        `${invalid.map((r) => r.address).join(', ')} ${invalid.length > 1 ? 'are not valid addresses' : 'is not a valid address'}.`
      )
      return
    }
    if (!accountId) {
      setSendError('Choose an account to send from.')
      return
    }

    const warnings: string[] = []
    if (!subject.trim()) warnings.push('This message has no subject.')
    if (isBodyEmpty(body)) warnings.push('The message body is empty.')
    if (!attachments.length && mentionsAttachment(body)) {
      warnings.push('The message mentions an attachment, but nothing is attached.')
    }

    if (warnings.length) {
      setConfirm({
        title: 'Send anyway?',
        message: (
          <ul className="cw-warn-list">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ),
        confirmLabel: 'Send anyway',
        onConfirm: () => {
          setConfirm(null)
          void doSend()
        }
      })
      return
    }
    void doSend()
  }, [to, cc, bcc, accountId, subject, body, attachments, doSend])

  // -------------------------------------------------------------- discard ---

  const discardNow = useCallback(async () => {
    dirty.current = false
    if (draftId) {
      try {
        await api.invoke('drafts:delete', { draftId })
      } catch {
        /* closing anyway */
      }
    }
    closing.current = true
    window.close()
  }, [draftId])

  const onDiscard = useCallback(() => {
    if (isEmpty()) {
      void discardNow()
      return
    }
    setConfirm({
      title: 'Discard this message?',
      message: 'The message and any saved draft will be deleted. This cannot be undone.',
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: () => {
        setConfirm(null)
        void discardNow()
      }
    })
  }, [isEmpty, discardNow])

  // ------------------------------------------------------------ shortcuts ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        onSend()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveDraftRef.current(false)
        return
      }
      if (e.key === 'Escape') {
        const el = document.activeElement
        const inField =
          el instanceof HTMLElement &&
          el !== document.body &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.isContentEditable ||
            el.closest('.ul-modal') != null)
        if (inField) return
        e.preventDefault()
        onDiscard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSend, onDiscard])

  // ----------------------------------------------------------------- view ---

  if (loading) {
    return (
      <div className="cw-root">
        <header className="cw-titlebar">
          <span className="cw-title">New message</span>
        </header>
        <div className="cw-loading">
          <Spinner size={20} />
        </div>
      </div>
    )
  }

  const attachTotal = totalAttachmentBytes(attachments)
  const overLimit = attachTotal > MAX_TOTAL_ATTACHMENT_BYTES

  return (
    <div className={`cw-root ${dragging ? 'is-dragging' : ''}`}>
      <header className="cw-titlebar">
        <span className="cw-title">{windowTitleFor(subject, mode)}</span>
      </header>

      <div className="cw-headers">
        <div className="cw-field cw-from">
          <label className="cw-field-label" htmlFor="cw-from">
            From
          </label>
          <div className="cw-from-control">
            <span
              className="cw-dot"
              style={{ background: account?.color ?? 'var(--fg-faint)' }}
              aria-hidden="true"
            />
            <select
              id="cw-from"
              className="cw-select"
              value={accountId}
              onChange={(e) => onChangeAccount(e.currentTarget.value)}
            >
              {enabledAccounts.length === 0 && <option value="">No accounts</option>}
              {enabledAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ? `${a.name} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </div>
        </div>

        <RecipientInput
          id="cw-to"
          label="To"
          value={to}
          autoFocus={to.length === 0}
          placeholder="Recipients"
          onChange={(v) => {
            setTo(v)
            markDirty()
          }}
          trailing={
            <>
              {!showCc && (
                <button type="button" className="cw-linkbtn" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              )}
              {!showBcc && (
                <button type="button" className="cw-linkbtn" onClick={() => setShowBcc(true)}>
                  Bcc
                </button>
              )}
            </>
          }
        />

        {showCc && (
          <RecipientInput
            id="cw-cc"
            label="Cc"
            value={cc}
            placeholder="Carbon copy"
            onChange={(v) => {
              setCc(v)
              markDirty()
            }}
          />
        )}
        {showBcc && (
          <RecipientInput
            id="cw-bcc"
            label="Bcc"
            value={bcc}
            placeholder="Blind carbon copy"
            onChange={(v) => {
              setBcc(v)
              markDirty()
            }}
          />
        )}

        <div className="cw-field">
          <label className="cw-field-label" htmlFor="cw-subject">
            Subject
          </label>
          <input
            id="cw-subject"
            className="cw-subject"
            value={subject}
            placeholder="Subject"
            spellCheck={false}
            onChange={(e) => {
              setSubject(e.currentTarget.value)
              markDirty()
            }}
          />
        </div>
      </div>

      <div className="cw-body">
        <ComposeEditor
          initialHtml={initialBody}
          showToolbar={showToolbar}
          onSendShortcut={onSend}
          onPasteImage={onPasteImage}
          onChange={(html) => {
            setBody(html)
            markDirty()
          }}
        />

        {quote && (
          <div className="cw-quote-block">
            <button
              type="button"
              className="cw-quote-toggle"
              aria-expanded={quoteOpen}
              onClick={() => setQuoteOpen((q) => !q)}
              title={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
            >
              …
            </button>
            {quoteOpen && (
              <div
                className="cw-quote"
                // Quoted text was produced by main from the original message; it is shown
                // read-only and merged back verbatim on send.
                dangerouslySetInnerHTML={{ __html: quote }}
              />
            )}
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className={`cw-attachments ${overLimit ? 'is-over' : ''}`}>
          {attachments.map((a, i) => (
            <span key={`${a.filename}-${i}`} className="cw-attach-chip" title={a.filename}>
              {a.contentId && <span className="cw-attach-inline" aria-label="Inline image">🖼</span>}
              <span className="cw-attach-name">{a.filename}</span>
              <span className="cw-attach-size">{formatBytes(a.size)}</span>
              <button
                type="button"
                className="cw-chip-x"
                aria-label={`Remove ${a.filename}`}
                onClick={() => removeAttachment(i)}
              >
                ×
              </button>
            </span>
          ))}
          <span className={`cw-attach-total ${overLimit ? 'is-over' : ''}`}>
            {formatBytes(attachTotal)} total
          </span>
        </div>
      )}

      {sendError && (
        <div className="cw-error" role="alert">
          {sendError}
        </div>
      )}

      <footer className="cw-footer">
        <Button variant="primary" onClick={onSend} loading={sending} title="Send (Ctrl+Enter)">
          Send
        </Button>
        <IconButton
          title="Formatting options"
          active={showToolbar}
          onClick={() => setShowToolbar((s) => !s)}
        >
          Aa
        </IconButton>
        <IconButton title="Attach files" onClick={() => void pickFiles()}>
          📎
        </IconButton>
        <div className="cw-footer-spacer" />
        <span className="cw-status" aria-live="polite">
          {savingDraft ? 'Saving…' : savedAt ? `Saved · ${formatClock(savedAt)}` : ''}
        </span>
        <Button variant="ghost" onClick={() => void saveDraftRef.current(false)}>
          Save draft
        </Button>
        <IconButton title="Discard draft" onClick={onDiscard}>
          🗑
        </IconButton>
      </footer>

      {dragging && (
        <div className="cw-dropzone">
          <div className="cw-dropzone-inner">Drop files to attach</div>
        </div>
      )}

      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        danger={confirm?.danger}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

export default ComposeApp
