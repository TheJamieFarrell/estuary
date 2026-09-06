import type { ReactElement, ReactNode } from 'react'
import { useMemo } from 'react'
import type { Account, Folder, FolderKind } from '@shared/types'
import { Button, IconButton } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { SyncDot, syncLabel } from '@renderer/features/common/SyncDot'
import { formatCount } from '@renderer/lib/format'
import type { MailView } from '@renderer/lib/store'
import { mailViewEquals, useStore } from '@renderer/lib/store'
import './nav.css'

const KIND_ORDER: FolderKind[] = ['inbox', 'starred', 'sent', 'drafts', 'archive', 'all', 'important', 'spam', 'trash']

function kindIcon(kind: FolderKind): ReactElement {
  switch (kind) {
    case 'inbox':
      return <Icons.Inbox size={15} />
    case 'sent':
      return <Icons.Send size={15} />
    case 'drafts':
      return <Icons.Draft size={15} />
    case 'trash':
      return <Icons.Trash size={15} />
    case 'spam':
      return <Icons.Spam size={15} />
    case 'archive':
    case 'all':
      return <Icons.Archive size={15} />
    case 'starred':
      return <Icons.Star size={15} />
    case 'important':
      return <Icons.StarFilled size={15} />
    default:
      return <Icons.Folder size={15} />
  }
}

interface ItemProps {
  icon: ReactNode
  label: string
  count?: number
  active: boolean
  depth?: number
  onClick: () => void
  title?: string
}

function NavItem({ icon, label, count, active, depth = 0, onClick, title }: ItemProps): ReactElement {
  const cls = [
    'nv__item',
    active ? 'nv__item--active' : '',
    depth === 1 ? 'nv__item--nested' : depth >= 2 ? 'nv__item--nested2' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} onClick={onClick} title={title ?? label} aria-current={active ? 'page' : undefined}>
      <span className="nv__icon">{icon}</span>
      <span className="nv__label">{label}</span>
      {count && count > 0 ? <span className="nv__count">{formatCount(count)}</span> : null}
    </button>
  )
}

/** Depth of a custom folder relative to its account root. */
function folderDepth(folder: Folder): number {
  const d = folder.delimiter || '/'
  const path = folder.path.replace(new RegExp(`^INBOX\\${d}`), '')
  return Math.max(0, path.split(d).length - 1)
}

function sortFolders(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a.kind)
    const bi = KIND_ORDER.indexOf(b.kind)
    const av = ai < 0 ? 99 : ai
    const bv = bi < 0 ? 99 : bi
    if (av !== bv) return av - bv
    return a.path.localeCompare(b.path)
  })
}

const UNIFIED_ENTRIES: { kind: FolderKind | 'starred'; label: string; view: MailView }[] = [
  { kind: 'inbox', label: 'Inbox', view: { kind: 'unified', folderKind: 'inbox', label: 'Inbox' } },
  { kind: 'starred', label: 'Starred', view: { kind: 'unified', starred: true, label: 'Starred' } },
  { kind: 'sent', label: 'Sent', view: { kind: 'unified', folderKind: 'sent', label: 'Sent' } },
  { kind: 'drafts', label: 'Drafts', view: { kind: 'unified', folderKind: 'drafts', label: 'Drafts' } },
  { kind: 'archive', label: 'Archive', view: { kind: 'unified', folderKind: 'archive', label: 'Archive' } },
  { kind: 'spam', label: 'Spam', view: { kind: 'unified', folderKind: 'spam', label: 'Spam' } },
  { kind: 'trash', label: 'Trash', view: { kind: 'unified', folderKind: 'trash', label: 'Trash' } }
]

export interface NavProps {
  onCompose: () => void
}

export function Nav({ onCompose }: NavProps): ReactElement {
  const accounts = useStore((s) => s.accounts)
  const folders = useStore((s) => s.folders)
  const unread = useStore((s) => s.unread)
  const mailView = useStore((s) => s.mailView)
  const view = useStore((s) => s.view)
  const collapsed = useStore((s) => s.collapsedAccounts)
  const syncStatuses = useStore((s) => s.syncStatuses)
  const openMailView = useStore((s) => s.openMailView)
  const toggleAccountCollapsed = useStore((s) => s.toggleAccountCollapsed)
  const setView = useStore((s) => s.setView)

  const byAccount = useMemo(() => {
    const map = new Map<string, Folder[]>()
    for (const f of folders) {
      const list = map.get(f.accountId) ?? []
      list.push(f)
      map.set(f.accountId, list)
    }
    for (const [k, v] of map) map.set(k, sortFolders(v))
    return map
  }, [folders])

  const isActive = (v: MailView): boolean => view === 'inbox' && mailViewEquals(mailView, v)

  function accountFolderView(account: Account, folder: Folder): MailView {
    return {
      kind: 'account',
      accountId: account.id,
      folderId: folder.id,
      folderKind: folder.kind,
      label: folder.kind === 'inbox' ? `${folder.name} — ${account.email}` : folder.name
    }
  }

  return (
    <nav className="nv" aria-label="Mailboxes">
      <div className="nv__top">
        <Button variant="primary" icon={<Icons.Compose size={15} />} className="nv__compose" block onClick={onCompose}>
          Compose
        </Button>
      </div>

      <div className="nv__scroll">
        {accounts.length > 1 ? <div className="nv__section-title">All accounts</div> : null}
        {UNIFIED_ENTRIES.map((entry) => (
          <NavItem
            key={entry.label}
            icon={kindIcon(entry.kind as FolderKind)}
            label={entry.label}
            count={entry.kind === 'inbox' ? unread.inbox : 0}
            active={isActive(entry.view)}
            onClick={() => openMailView(entry.view)}
          />
        ))}

        {accounts.map((account) => {
          const isCollapsed = collapsed[account.id]
          const status = syncStatuses[account.id]
          const list = byAccount.get(account.id) ?? []
          return (
            <div className="nv__group" key={account.id}>
              <button
                type="button"
                className="nv__group-head"
                onClick={() => toggleAccountCollapsed(account.id)}
                aria-expanded={!isCollapsed}
                title={`${account.email} — ${syncLabel(status)}`}
              >
                <span className="nv__group-chevron">
                  {isCollapsed ? <Icons.ChevronRight size={13} /> : <Icons.ChevronDown size={13} />}
                </span>
                <span className="nv__dot" style={{ background: account.color }} aria-hidden="true" />
                <span className="nv__group-email">{account.email}</span>
                <span className="nv__group-status">
                  {status?.state === 'error' ? (
                    <span
                      className="nv__fix"
                      role="button"
                      tabIndex={0}
                      title={status.error ?? 'Reconnect this account'}
                      onClick={(e) => {
                        e.stopPropagation()
                        setView('accounts')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          setView('accounts')
                        }
                      }}
                    >
                      Fix
                    </span>
                  ) : (
                    <SyncDot status={status} />
                  )}
                </span>
              </button>

              {isCollapsed
                ? null
                : list.map((folder) => (
                    <NavItem
                      key={folder.id}
                      icon={kindIcon(folder.kind)}
                      label={folder.name}
                      count={unread.byFolder[folder.id] ?? (folder.kind === 'inbox' ? (unread.byAccount[account.id] ?? 0) : 0)}
                      depth={folder.kind === 'custom' ? 1 + folderDepth(folder) : 1}
                      active={isActive(accountFolderView(account, folder))}
                      title={`${folder.path} — ${account.email}`}
                      onClick={() => openMailView(accountFolderView(account, folder))}
                    />
                  ))}
            </div>
          )
        })}
      </div>

      <div className="nv__bottom">
        <button type="button" className="nv__item" onClick={() => setView('accounts')}>
          <span className="nv__icon">
            <Icons.Plus size={15} />
          </span>
          <span className="nv__label">Add account</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <button
            type="button"
            className="nv__item"
            onClick={() => setView('settings')}
            aria-current={view === 'settings' ? 'page' : undefined}
          >
            <span className="nv__icon">
              <Icons.Settings size={15} />
            </span>
            <span className="nv__label">Settings</span>
          </button>
          <IconButton title="Keyboard shortcuts (?)" onClick={() => useStore.getState().setShortcutsOpen(true)}>
            <span aria-hidden="true" style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>
              ?
            </span>
          </IconButton>
        </div>
      </div>
    </nav>
  )
}

export default Nav
