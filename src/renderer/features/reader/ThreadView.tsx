import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, MessageFull } from '@shared/types'
import { Avatar, Button, Dropdown, EmptyState, IconButton, Modal, Spinner, useToast } from '@renderer/components/ui'
import type { MenuItem } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { api } from '@renderer/lib/api'
import {
  displayName,
  formatAddressList,
  formatBytes,
  messageDate,
  fullDate,
  pluralise,
  subjectOrFallback
} from '@renderer/lib/format'
import { selectMeAddresses, useStore } from '@renderer/lib/store'
import { MessageBody } from './MessageBody'
import './reader.css'

function AttachmentChip({ att }: { att: AttachmentMeta }): ReactElement {
  const toast = useToast()
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!att.contentType.startsWith('image/')) return
    void api
      .invoke('attachments:inlineDataUrl', { attachmentId: att.id })
      .then((url) => {
        if (!cancelled && url) setThumb(url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [att.id, att.contentType])

  return (
    <div
      className="tv-attachment"
      role="button"
      tabIndex={0}
      title={`${att.filename} · ${formatBytes(att.size)}`}
      onClick={() => {
        void api.invoke('attachments:open', { attachmentId: att.id }).catch((e: Error) => toast.error(e.message))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void api.invoke('attachments:open', { attachmentId: att.id })
      }}
    >
      {thumb ? (
        <img className="tv-attachment__thumb" src={thumb} alt="" />
      ) : (
        <span className="tv-attachment__thumb">
          <Icons.Attachment size={16} />
        </span>
      )}
      <div className="tv-attachment__meta">
        <div className="tv-attachment__name">{att.filename}</div>
        <div className="tv-attachment__size">{formatBytes(att.size)}</div>
      </div>
      <IconButton
        title="Save as…"
        size="sm"
        onClick={(e) => {
          e.stopPropagation()
          void api
            .invoke('attachments:saveAs', { attachmentId: att.id })
            .then((r) => {
              if (r.saved) toast.success(`Saved ${att.filename}`)
            })
            .catch((err: Error) => toast.error(err.message))
        }}
      >
        <Icons.Download size={14} />
      </IconButton>
    </div>
  )
}

interface MessageItemProps {
  message: MessageFull
  expanded: boolean
  isLast: boolean
  meAddresses: string[]
  loadRemoteImages: boolean
  onToggle: () => void
  onViewSource: (message: MessageFull) => void
}

function MessageItem({
  message,
  expanded,
  isLast,
  meAddresses,
  loadRemoteImages,
  onToggle,
  onViewSource
}: MessageItemProps): ReactElement {
  const [showDetails, setShowDetails] = useState(false)
  const from = message.from[0]
  const unread = !message.flags.seen

  return (
    <article
      className={[
        'tv-message',
        expanded ? '' : 'tv-message--collapsed',
        unread ? 'tv-message--unread' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* role=button rather than <button> so the action icons inside stay valid HTML */}
      <div
        className="tv-message__head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <Avatar address={from?.address ?? ''} name={from?.name} size={32} />
        <div className="tv-message__who">
          <div className="tv-message__from">
            {displayName(from)}
            <span className="tv-message__address">{from?.address}</span>
          </div>
          {expanded ? (
            <div className="tv-message__to">
              <span>to {formatAddressList(message.to, meAddresses)}</span>
              <IconButton
                title={showDetails ? 'Hide details' : 'Show details'}
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDetails((v) => !v)
                }}
              >
                <Icons.ChevronDown size={12} />
              </IconButton>
            </div>
          ) : (
            <div className="tv-message__preview">{message.snippet}</div>
          )}
        </div>
        <div className="tv-message__right">
          {message.hasAttachments ? <Icons.Attachment size={14} /> : null}
          {message.flags.flagged ? <Icons.StarFilled size={14} /> : null}
          <span className="tv-message__date" title={fullDate(message.date)}>
            {messageDate(message.date)}
          </span>
          <IconButton
            title="Message actions"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onViewSource(message)
            }}
          >
            <Icons.Code size={14} />
          </IconButton>
        </div>
      </div>

      {expanded && showDetails ? (
        <dl className="tv-message__details">
          <dt>From</dt>
          <dd>{formatAddressList(message.from, meAddresses)}</dd>
          <dt>To</dt>
          <dd>{formatAddressList(message.to, meAddresses)}</dd>
          {message.cc.length > 0 ? (
            <>
              <dt>Cc</dt>
              <dd>{formatAddressList(message.cc, meAddresses)}</dd>
            </>
          ) : null}
          <dt>Date</dt>
          <dd>{fullDate(message.date)}</dd>
          <dt>Subject</dt>
          <dd>{subjectOrFallback(message.subject)}</dd>
        </dl>
      ) : null}

      {expanded ? (
        <>
          <MessageBody message={message} loadRemoteImages={loadRemoteImages} />
          {message.attachments.filter((a) => !a.isInline).length > 0 ? (
            <div className="tv-attachments">
              {message.attachments
                .filter((a) => !a.isInline)
                .map((att) => (
                  <AttachmentChip key={att.id} att={att} />
                ))}
            </div>
          ) : null}
        </>
      ) : null}
      {expanded && isLast ? <span /> : null}
    </article>
  )
}

export interface ThreadViewProps {
  threadId?: string
}

export function ThreadView({ threadId }: ThreadViewProps): ReactElement {
  const toast = useToast()
  const settings = useStore((s) => s.settings)
  const meAddresses = useStore(selectMeAddresses)
  const folders = useStore((s) => s.folders)
  const threads = useStore((s) => s.threads)
  const threadAction = useStore((s) => s.threadAction)

  const [messages, setMessages] = useState<MessageFull[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [rawSource, setRawSource] = useState<{ subject: string; text: string } | null>(null)
  const markTimer = useRef<number>(0)

  const summary = threads.find((t) => t.id === threadId)

  useEffect(() => {
    let cancelled = false
    window.clearTimeout(markTimer.current)
    if (!threadId) {
      setMessages([])
      return
    }
    setLoading(true)
    setError(undefined)
    void api
      .invoke('messages:thread', { threadId })
      .then((list) => {
        if (cancelled) return
        setMessages(list)
        setLoading(false)
        const next: Record<string, boolean> = {}
        list.forEach((m, i) => {
          next[m.id] = i === list.length - 1 || !m.flags.seen
        })
        setExpanded(next)

        // Mark read after the configured delay
        const delay = settings.markReadDelayMs
        const unreadIds = list.filter((m) => !m.flags.seen).map((m) => m.id)
        if (delay >= 0 && unreadIds.length > 0) {
          markTimer.current = window.setTimeout(() => {
            void api.invoke('messages:action', { action: 'markRead', messageIds: unreadIds }).catch(() => undefined)
          }, delay)
        }
      })
      .catch((e: Error) => {
        if (cancelled) return
        setLoading(false)
        setError(e.message)
      })
    return () => {
      cancelled = true
      window.clearTimeout(markTimer.current)
    }
  }, [threadId, settings.markReadDelayMs])

  const lastMessage = messages[messages.length - 1]

  const openCompose = useCallback(
    (mode: 'reply' | 'replyAll' | 'forward') => {
      if (!lastMessage) return
      void api
        .invoke('compose:open', { mode, messageId: lastMessage.id, accountId: lastMessage.accountId })
        .catch((e: Error) => toast.error(e.message))
    },
    [lastMessage, toast]
  )

  const moveItems = useMemo<MenuItem[]>(() => {
    if (!summary) return []
    const list = folders.filter((f) => f.accountId === summary.accountId && f.kind !== 'drafts')
    return [
      { heading: 'Move to folder' },
      ...list.map((f) => ({
        id: f.id,
        label: f.name,
        icon: <Icons.Folder size={14} />,
        onSelect: () => void threadAction('move', [summary.id], f.id)
      }))
    ]
  }, [folders, summary, threadAction])

  const viewSource = useCallback(
    (message: MessageFull) => {
      void api
        .invoke('messages:raw', { messageId: message.id })
        .then((text) => setRawSource({ subject: message.subject, text }))
        .catch((e: Error) => toast.error(e.message))
    },
    [toast]
  )

  if (!threadId) {
    return (
      <section className="tv">
        <div className="tv__empty">
          <EmptyState
            icon={<Icons.Mail size={34} />}
            title="No conversation selected"
            description="Pick a conversation from the list, or press j / k to move through it."
          />
        </div>
      </section>
    )
  }

  return (
    <section className="tv" aria-label="Conversation">
      <header className="tv__head">
        <h2 className="tv__subject">{subjectOrFallback(summary?.subject ?? messages[0]?.subject ?? '')}</h2>
        <div className="tv__submeta">
          <span>{pluralise(messages.length, 'message')}</span>
          {summary?.hasAttachments ? <span>· has attachments</span> : null}
        </div>
        <div className="tv__actions">
          <IconButton title="Archive (e)" onClick={() => summary && void threadAction('archive', [summary.id])}>
            <Icons.Archive size={16} />
          </IconButton>
          <IconButton
            title="Delete (#)"
            tone="danger"
            onClick={() => summary && void threadAction('trash', [summary.id])}
          >
            <Icons.Trash size={16} />
          </IconButton>
          <IconButton title="Report spam" onClick={() => summary && void threadAction('spam', [summary.id])}>
            <Icons.Spam size={16} />
          </IconButton>
          <span className="tv__actions-sep" />
          <IconButton
            title={summary?.hasStarred ? 'Unstar (s)' : 'Star (s)'}
            tone="star"
            active={summary?.hasStarred}
            onClick={() => summary && void threadAction(summary.hasStarred ? 'unstar' : 'star', [summary.id])}
          >
            {summary?.hasStarred ? <Icons.StarFilled size={16} /> : <Icons.Star size={16} />}
          </IconButton>
          <IconButton
            title="Mark as unread (u)"
            onClick={() => summary && void threadAction('markUnread', [summary.id])}
          >
            <Icons.Mail size={16} />
          </IconButton>
          <Dropdown
            trigger={
              <IconButton title="Move to…">
                <Icons.Move size={16} />
              </IconButton>
            }
            items={moveItems}
          />
          <Dropdown
            align="right"
            trigger={
              <IconButton title="More actions">
                <Icons.More size={16} />
              </IconButton>
            }
            items={[
              {
                label: 'View source',
                icon: <Icons.Code size={14} />,
                disabled: !lastMessage,
                onSelect: () => lastMessage && viewSource(lastMessage)
              },
              {
                label: 'Print',
                icon: <Icons.ExternalLink size={14} />,
                onSelect: () => window.print()
              }
            ]}
          />
          <span className="tv__spacer" />
        </div>
      </header>

      <div className="tv__scroll">
        {loading ? (
          <div className="cm-loading">
            <Spinner size={16} /> Loading conversation…
          </div>
        ) : error ? (
          <EmptyState icon={<Icons.Warning size={26} />} title="Could not load this conversation" description={error} />
        ) : (
          <>
            {messages.map((m, i) => (
              <MessageItem
                key={m.id}
                message={m}
                expanded={expanded[m.id] ?? false}
                isLast={i === messages.length - 1}
                meAddresses={meAddresses}
                loadRemoteImages={settings.loadRemoteImages}
                onToggle={() => setExpanded((cur) => ({ ...cur, [m.id]: !cur[m.id] }))}
                onViewSource={viewSource}
              />
            ))}
            {lastMessage ? (
              <div className="tv__reply-bar">
                <Button variant="secondary" icon={<Icons.Reply size={15} />} onClick={() => openCompose('reply')}>
                  Reply
                </Button>
                <Button variant="secondary" icon={<Icons.ReplyAll size={15} />} onClick={() => openCompose('replyAll')}>
                  Reply all
                </Button>
                <Button variant="secondary" icon={<Icons.Forward size={15} />} onClick={() => openCompose('forward')}>
                  Forward
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Modal
        open={rawSource !== null}
        onClose={() => setRawSource(null)}
        title={`Source — ${rawSource?.subject ?? ''}`}
        size="lg"
      >
        <pre className="cm-raw">{rawSource?.text}</pre>
      </Modal>
    </section>
  )
}

export default ThreadView
