import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ThreadSummary } from '@shared/types'
import { Avatar, Checkbox, Chip, Dropdown, EmptyState, IconButton, Spinner } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { formatParticipants, pluralise, relativeDate, subjectOrFallback } from '@renderer/lib/format'
import { useElementSize, useScrollTop, useVirtualWindow } from '@renderer/lib/hooks'
import { selectIsSyncing, selectMeAddresses, useStore } from '@renderer/lib/store'
import './inbox.css'

const ROW_H_COMFORTABLE = 76
const ROW_H_COMPACT = 62

interface RowProps {
  thread: ThreadSummary
  account?: Account
  showAccountBar: boolean
  selected: boolean
  checked: boolean
  meAddresses: string[]
  top: number
  height: number
  onOpen: (id: string, e: ReactMouseEvent) => void
  onCheck: (id: string, range: boolean) => void
  onStar: (t: ThreadSummary) => void
  onArchive: (id: string) => void
  onTrash: (id: string) => void
  onToggleRead: (t: ThreadSummary) => void
}

function ThreadRow({
  thread,
  account,
  showAccountBar,
  selected,
  checked,
  meAddresses,
  top,
  height,
  onOpen,
  onCheck,
  onStar,
  onArchive,
  onTrash,
  onToggleRead
}: RowProps): ReactElement {
  const unread = thread.unreadCount > 0
  const people = formatParticipants(thread.participants, { meAddresses })
  const cls = [
    'tl-row',
    unread ? 'tl-row--unread' : '',
    selected ? 'tl-row--selected' : '',
    checked ? 'tl-row--checked' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const primary = thread.participants[0]

  return (
    <div
      className={cls}
      style={{ position: 'absolute', top, left: 0, right: 0, height }}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-thread-id={thread.id}
      onClick={(e) => onOpen(thread.id, e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(thread.id, e as unknown as ReactMouseEvent)
        }
      }}
    >
      <span
        className="tl-row__bar"
        style={{ background: showAccountBar && account ? account.color : 'transparent' }}
        aria-hidden="true"
      />
      <div className="tl-row__lead">
        <span className="tl-row__avatar">
          <Avatar address={primary?.address ?? ''} name={primary?.name} size={28} />
        </span>
        <span className="tl-row__check">
          <Checkbox
            checked={checked}
            stopPropagation
            title={checked ? 'Deselect conversation' : 'Select conversation'}
            onChange={(_v, e) => onCheck(thread.id, 'shiftKey' in e ? Boolean((e as ReactMouseEvent).shiftKey) : false)}
          />
        </span>
      </div>

      <div className="tl-row__main">
        <div className="tl-row__line1">
          <span className="tl-row__people">{people}</span>
          {thread.messageCount > 1 ? <span className="tl-row__count">{thread.messageCount}</span> : null}
          <span className="tl-row__date" title={new Date(thread.lastDate).toLocaleString()}>
            {relativeDate(thread.lastDate)}
          </span>
        </div>
        <div className="tl-row__subject">
          {thread.hasDraft ? <span style={{ color: 'var(--danger)' }}>Draft · </span> : null}
          {subjectOrFallback(thread.subject)}
        </div>
        <div className="tl-row__snippet">{thread.snippet}</div>
      </div>

      <div className="tl-row__meta" onClick={(e) => e.stopPropagation()}>
        <IconButton
          title={thread.hasStarred ? 'Unstar' : 'Star'}
          size="sm"
          tone="star"
          active={thread.hasStarred}
          onClick={() => onStar(thread)}
        >
          {thread.hasStarred ? <Icons.StarFilled size={14} /> : <Icons.Star size={14} />}
        </IconButton>
        {thread.hasAttachments ? (
          <span className="tl-row__attach" title="Has attachments">
            <Icons.Attachment size={14} />
          </span>
        ) : null}
        <div className="tl-row__actions">
          <IconButton title="Archive (e)" size="sm" onClick={() => onArchive(thread.id)}>
            <Icons.Archive size={14} />
          </IconButton>
          <IconButton title="Delete (#)" size="sm" tone="danger" onClick={() => onTrash(thread.id)}>
            <Icons.Trash size={14} />
          </IconButton>
          <IconButton
            title={unread ? 'Mark as read' : 'Mark as unread'}
            size="sm"
            onClick={() => onToggleRead(thread)}
          >
            {unread ? <Icons.MailOpen size={14} /> : <Icons.Mail size={14} />}
          </IconButton>
        </div>
      </div>
    </div>
  )
}

export interface ThreadListProps {
  onOpenThread?: (threadId: string) => void
}

export function ThreadList({ onOpenThread }: ThreadListProps): ReactElement {
  const threads = useStore((s) => s.threads)
  const listLoading = useStore((s) => s.listLoading)
  const listLoadingMore = useStore((s) => s.listLoadingMore)
  const listError = useStore((s) => s.listError)
  const nextCursor = useStore((s) => s.nextCursor)
  const mailView = useStore((s) => s.mailView)
  const filters = useStore((s) => s.filters)
  const accounts = useStore((s) => s.accounts)
  const selectedThreadId = useStore((s) => s.selectedThreadId)
  const selectedIds = useStore((s) => s.selectedIds)
  const searchActive = useStore((s) => s.searchActive)
  const searchQuery = useStore((s) => s.searchQuery)
  const density = useStore((s) => s.settings.density)
  const syncing = useStore(selectIsSyncing)
  const meAddresses = useStore(selectMeAddresses)

  const selectThread = useStore((s) => s.selectThread)
  const toggleChecked = useStore((s) => s.toggleChecked)
  const clearChecked = useStore((s) => s.clearChecked)
  const checkAll = useStore((s) => s.checkAll)
  const toggleFilter = useStore((s) => s.toggleFilter)
  const threadAction = useStore((s) => s.threadAction)
  const loadMore = useStore((s) => s.loadMore)
  const syncNow = useStore((s) => s.syncNow)
  const clearSearch = useStore((s) => s.clearSearch)

  const [sortDesc, setSortDesc] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sizeRef, size] = useElementSize<HTMLDivElement>()
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const scrollTop = useScrollTop(scrollEl)
  const attachScroll = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      setScrollEl(node)
      sizeRef(node)
    },
    [sizeRef]
  )

  const rowHeight = density === 'compact' ? ROW_H_COMPACT : ROW_H_COMFORTABLE
  const ordered = useMemo(
    () => (sortDesc ? threads : [...threads].sort((a, b) => a.lastDate - b.lastDate)),
    [threads, sortDesc]
  )
  const win = useVirtualWindow(ordered.length, rowHeight, size.height, scrollTop)

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const showAccountBar = mailView.kind === 'unified' && accounts.length > 1

  const unreadInList = ordered.reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0)

  // Infinite scroll. The scroll handler reads live DOM values (so it fires even when the
  // rAF-throttled scrollTop state lags); the effect covers the case where the first page
  // does not fill the viewport and no scroll event ever happens.
  const maybeLoadMore = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 6) void loadMore()
  }, [loadMore, rowHeight])

  useEffect(() => {
    if (!nextCursor || listLoadingMore) return
    const remaining = win.totalHeight - (scrollTop + size.height)
    if (remaining < rowHeight * 6) void loadMore()
  }, [scrollTop, size.height, win.totalHeight, nextCursor, listLoadingMore, loadMore, rowHeight])

  // Keep the keyboard-selected row in view
  useEffect(() => {
    if (!selectedThreadId || !scrollRef.current) return
    const idx = ordered.findIndex((t) => t.id === selectedThreadId)
    if (idx < 0) return
    const el = scrollRef.current
    const top = idx * rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight
  }, [selectedThreadId, ordered, rowHeight])

  const onOpen = useCallback(
    (id: string, e: ReactMouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        toggleChecked(id)
        return
      }
      if (e.shiftKey) {
        toggleChecked(id, { range: true })
        return
      }
      selectThread(id)
      onOpenThread?.(id)
    },
    [selectThread, toggleChecked, onOpenThread]
  )

  const title = searchActive ? `Search results for “${searchQuery}”` : mailView.label
  const bulkIds = selectedIds

  return (
    <section className="tl" aria-label="Conversations">
      <header className="tl__head">
        <div className="tl__head-row">
          <h1 className="tl__title" title={title}>
            {title}
          </h1>
          {searchActive ? (
            <IconButton title="Clear search" size="sm" onClick={clearSearch}>
              <Icons.Close size={14} />
            </IconButton>
          ) : null}
          <span className="tl__spacer" />
          <span className="tl__sub">
            {unreadInList > 0 ? `${unreadInList} unread · ` : ''}
            {pluralise(ordered.length, 'conversation')}
            {nextCursor ? '+' : ''}
          </span>
          <IconButton title="Refresh (F5)" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? <Spinner size={15} /> : <Icons.Refresh size={15} />}
          </IconButton>
          <Dropdown
            align="right"
            trigger={
              <IconButton title="Sort">
                <Icons.Filter size={15} />
              </IconButton>
            }
            items={[
              { heading: 'Sort by date' },
              { label: 'Newest first', checked: sortDesc, onSelect: () => setSortDesc(true) },
              { label: 'Oldest first', checked: !sortDesc, onSelect: () => setSortDesc(false) },
              { separator: true },
              { label: 'Select all', shortcut: 'Ctrl+A', onSelect: checkAll }
            ]}
          />
        </div>
        <div className="tl__filters">
          <Chip active={filters.unread} onClick={() => toggleFilter('unread')} title="Show only unread">
            Unread
          </Chip>
          <Chip active={filters.starred} onClick={() => toggleFilter('starred')} title="Show only starred">
            Starred
          </Chip>
          <Chip
            active={filters.attachments}
            onClick={() => toggleFilter('attachments')}
            title="Show only conversations with attachments"
          >
            Attachments
          </Chip>
        </div>
      </header>

      {bulkIds.length > 0 ? (
        <div className="tl__bulk" role="toolbar" aria-label="Bulk actions">
          <span className="tl__bulk-count">{pluralise(bulkIds.length, 'selected', 'selected')}</span>
          <IconButton title="Archive" onClick={() => void threadAction('archive', bulkIds)}>
            <Icons.Archive size={15} />
          </IconButton>
          <IconButton title="Delete" tone="danger" onClick={() => void threadAction('trash', bulkIds)}>
            <Icons.Trash size={15} />
          </IconButton>
          <IconButton title="Mark as read" onClick={() => void threadAction('markRead', bulkIds)}>
            <Icons.MailOpen size={15} />
          </IconButton>
          <IconButton title="Mark as unread" onClick={() => void threadAction('markUnread', bulkIds)}>
            <Icons.Mail size={15} />
          </IconButton>
          <IconButton title="Star" tone="star" onClick={() => void threadAction('star', bulkIds)}>
            <Icons.Star size={15} />
          </IconButton>
          <IconButton title="Report spam" onClick={() => void threadAction('spam', bulkIds)}>
            <Icons.Spam size={15} />
          </IconButton>
          <span className="tl__spacer" />
          <IconButton title="Clear selection" onClick={clearChecked}>
            <Icons.Close size={15} />
          </IconButton>
        </div>
      ) : null}

      <div
        className="tl__scroll"
        ref={attachScroll}
        onScroll={maybeLoadMore}
        role="listbox"
        aria-label="Conversation list"
        tabIndex={-1}
      >
        {listLoading && ordered.length === 0 ? (
          <div className="tl__skeleton" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="tl__skeleton-row" key={i}>
                <div className="tl__skeleton-dot" />
                <div className="tl__skeleton-lines">
                  <div className="tl__skeleton-line tl__skeleton-line--short" />
                  <div className="tl__skeleton-line tl__skeleton-line--mid" />
                  <div className="tl__skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : listError ? (
          <EmptyState
            icon={<Icons.Warning size={28} />}
            title="Could not load conversations"
            description={listError}
          />
        ) : ordered.length === 0 ? (
          <EmptyState
            icon={<Icons.Inbox size={30} />}
            title={searchActive ? 'No matching conversations' : 'Nothing here'}
            description={
              searchActive
                ? 'Try a different search, or clear the filters.'
                : filters.unread || filters.starred || filters.attachments
                  ? 'No conversations match the active filters.'
                  : 'This folder is empty.'
            }
          />
        ) : (
          <div className="tl__rows" style={{ height: win.totalHeight }}>
            {ordered.slice(win.start, win.end).map((thread, i) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                account={accountsById.get(thread.accountId)}
                showAccountBar={showAccountBar}
                selected={thread.id === selectedThreadId}
                checked={selectedIds.includes(thread.id)}
                meAddresses={meAddresses}
                top={(win.start + i) * rowHeight}
                height={rowHeight}
                onOpen={onOpen}
                onCheck={(id, range) => toggleChecked(id, { range })}
                onStar={(t) => void threadAction(t.hasStarred ? 'unstar' : 'star', [t.id])}
                onArchive={(id) => void threadAction('archive', [id])}
                onTrash={(id) => void threadAction('trash', [id])}
                onToggleRead={(t) => void threadAction(t.unreadCount > 0 ? 'markRead' : 'markUnread', [t.id])}
              />
            ))}
          </div>
        )}
        {listLoadingMore ? (
          <div className="tl__more">
            <Spinner size={14} /> Loading more…
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default ThreadList
