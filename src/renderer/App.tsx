import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UpdateInfo } from '@shared/ipc'
import { Button, IconButton, ToastProvider, useToast } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { api } from '@renderer/lib/api'
import { useMediaQuery, useResolvedTheme } from '@renderer/lib/hooks'
import { useGlobalShortcuts } from '@renderer/lib/shortcuts'
import { selectAccount, selectIsOffline, useStore } from '@renderer/lib/store'
import { ErrorBoundary } from '@renderer/features/common/ErrorBoundary'
import { ShortcutsHelp } from '@renderer/features/common/ShortcutsHelp'
import Nav from '@renderer/features/nav/Nav'
import ThreadList from '@renderer/features/inbox/ThreadList'
import ThreadView from '@renderer/features/reader/ThreadView'
import SearchBar, { SEARCH_INPUT_ID } from '@renderer/features/search/SearchBar'
import SettingsPage from '@renderer/features/settings/SettingsPage'
import AccountsPage from '@renderer/features/accounts/AccountsPage'

function AuthErrorBanner(): ReactElement | null {
  const authErrors = useStore((s) => s.authErrors)
  const accounts = useStore((s) => s.accounts)
  const setView = useStore((s) => s.setView)
  const dismiss = useStore((s) => s.dismissAuthError)

  const first = Object.values(authErrors)[0]
  if (!first) return null
  const account = accounts.find((a) => a.id === first.accountId)
  const who = account ? account.email : 'An account'

  return (
    <div className="banner banner--danger" role="alert">
      <span className="banner__icon">
        <Icons.Warning size={15} />
      </span>
      <span className="banner__text">
        {who} — {first.message || 'sign-in expired'}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setView('accounts')
          dismiss(first.accountId)
        }}
      >
        Reconnect
      </Button>
      <IconButton title="Dismiss" size="sm" onClick={() => dismiss(first.accountId)}>
        <Icons.Close size={13} />
      </IconButton>
    </div>
  )
}

function UpdateBanner(): ReactElement | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)
  const toast = useToast()
  useEffect(() => {
    const off = api.on('update:available', (u) => {
      setInfo(u)
      setHidden(false)
    })
    void api.invoke('update:check', undefined).then((u) => u && setInfo(u)).catch(() => undefined)
    return off
  }, [])
  if (!info || hidden) return null
  return (
    <div className="banner banner--info" role="status">
      <span className="banner__icon">
        <Icons.Download size={15} />
      </span>
      <span className="banner__text">
        Estuary {info.version} is ready (you have {info.currentVersion}). Updating keeps your accounts signed in and
        restarts the app.
      </span>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        onClick={() => {
          setBusy(true)
          void api
            .invoke('update:install', undefined)
            .then((r) => {
              if (!r.ok) toast.error(r.error ?? 'Could not start the update')
            })
            .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Update now
      </Button>
      <IconButton title="Later" size="sm" onClick={() => setHidden(true)}>
        <Icons.Close size={13} />
      </IconButton>
    </div>
  )
}

function OfflineBanner(): ReactElement | null {
  const offline = useStore(selectIsOffline)
  if (!offline) return null
  return (
    <div className="banner banner--muted" role="status">
      <span className="banner__icon">
        <Icons.Offline size={15} />
      </span>
      <span className="banner__text">You are offline — showing cached mail. New messages will sync when you reconnect.</span>
    </div>
  )
}

function FirstRun(): ReactElement {
  const setView = useStore((s) => s.setView)
  return (
    <div className="firstrun">
      <div className="firstrun__card">
        <span className="firstrun__logo">
          <Icons.Mail size={48} />
        </span>
        <div className="firstrun__title">Welcome to Estuary</div>
        <p className="firstrun__desc">
          Bring Gmail, Outlook, Spacemail and any IMAP mailbox into a single inbox. Nothing leaves your machine —
          mail is cached locally and credentials are encrypted by Windows.
        </p>
        <Button variant="primary" icon={<Icons.Plus size={15} />} onClick={() => setView('accounts')}>
          Add your first account
        </Button>
      </div>
    </div>
  )
}

function Shell(): ReactElement {
  const toast = useToast()
  const ready = useStore((s) => s.ready)
  const bootError = useStore((s) => s.bootError)
  const accounts = useStore((s) => s.accounts)
  const view = useStore((s) => s.view)
  const navOpen = useStore((s) => s.navOpen)
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)
  const selectedThreadId = useStore((s) => s.selectedThreadId)
  const selectedIds = useStore((s) => s.selectedIds)
  const searchActive = useStore((s) => s.searchActive)
  const lastError = useStore((s) => s.lastError)
  const threads = useStore((s) => s.threads)

  const init = useStore((s) => s.init)
  const setView = useStore((s) => s.setView)
  const setNavOpen = useStore((s) => s.setNavOpen)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const openMailView = useStore((s) => s.openMailView)
  const moveSelection = useStore((s) => s.moveSelection)
  const selectThread = useStore((s) => s.selectThread)
  const toggleChecked = useStore((s) => s.toggleChecked)
  const clearChecked = useStore((s) => s.clearChecked)
  const threadAction = useStore((s) => s.threadAction)
  const clearSearch = useStore((s) => s.clearSearch)
  const syncNow = useStore((s) => s.syncNow)

  const narrow = useMediaQuery('(max-width: 900px)')
  const resolvedTheme = useResolvedTheme()
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void init()
  }, [init])

  useEffect(() => {
    setNavOpen(!narrow)
  }, [narrow, setNavOpen])

  // Surface store errors as toasts
  const lastShown = useRef(0)
  useEffect(() => {
    if (!lastError || lastError.at === lastShown.current) return
    lastShown.current = lastError.at
    toast.error(lastError.message, 'Action failed')
  }, [lastError, toast])

  const targetIds = useMemo(
    () => (selectedIds.length > 0 ? selectedIds : selectedThreadId ? [selectedThreadId] : []),
    [selectedIds, selectedThreadId]
  )

  function compose(): void {
    void api.invoke('compose:open', {}).catch((e: Error) => toast.error(e.message))
  }

  function replyTo(mode: 'reply' | 'replyAll' | 'forward'): void {
    const thread = threads.find((t) => t.id === selectedThreadId)
    const messageId = thread?.messageIds[thread.messageIds.length - 1]
    if (!messageId) return
    void api.invoke('compose:open', { mode, messageId, accountId: thread?.accountId }).catch((e: Error) =>
      toast.error(e.message)
    )
  }

  useGlobalShortcuts(
    {
      next: () => moveSelection(1),
      prev: () => moveSelection(-1),
      open: () => selectedThreadId && selectThread(selectedThreadId),
      archive: () => targetIds.length > 0 && void threadAction('archive', targetIds),
      trash: () => targetIds.length > 0 && void threadAction('trash', targetIds),
      reply: () => replyTo('reply'),
      replyAll: () => replyTo('replyAll'),
      forward: () => replyTo('forward'),
      star: () => {
        const thread = threads.find((t) => t.id === selectedThreadId)
        if (targetIds.length === 0) return
        void threadAction(thread?.hasStarred ? 'unstar' : 'star', targetIds)
      },
      markUnread: () => targetIds.length > 0 && void threadAction('markUnread', targetIds),
      markRead: () => targetIds.length > 0 && void threadAction('markRead', targetIds),
      toggleSelect: () => selectedThreadId && toggleChecked(selectedThreadId),
      compose,
      focusSearch: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
      escape: () => {
        if (searchActive) clearSearch()
        else if (selectedIds.length > 0) clearChecked()
        else selectThread(undefined)
      },
      gotoInbox: () => openMailView({ kind: 'unified', folderKind: 'inbox', label: 'Inbox' }),
      gotoStarred: () => openMailView({ kind: 'unified', starred: true, label: 'Starred' }),
      gotoSent: () => openMailView({ kind: 'unified', folderKind: 'sent', label: 'Sent' }),
      gotoDrafts: () => openMailView({ kind: 'unified', folderKind: 'drafts', label: 'Drafts' }),
      help: () => setShortcutsOpen(true),
      refresh: () => void syncNow()
    },
    ready && !shortcutsOpen
  )

  const classes = [
    'app',
    navOpen && narrow ? 'app--nav-open' : '',
    selectedThreadId ? 'app--reading' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const showChrome = accounts.length > 0

  return (
    <div className={classes}>
      <header className="titlebar">
        {narrow ? (
          <IconButton title={navOpen ? 'Hide mailboxes' : 'Show mailboxes'} onClick={() => setNavOpen(!navOpen)}>
            <Icons.Menu size={16} />
          </IconButton>
        ) : null}
        <span className="titlebar__brand">
          <Icons.Mail size={16} />
          Estuary
        </span>
        <div className="titlebar__center">{showChrome ? <SearchBar /> : null}</div>
        <div className="titlebar__right">
          <IconButton
            title={resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() =>
              void useStore.getState().updateSettings({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })
            }
          >
            {resolvedTheme === 'dark' ? <Icons.Sun size={16} /> : <Icons.Moon size={16} />}
          </IconButton>
          <IconButton title="New message (Ctrl+N)" onClick={compose}>
            <Icons.Compose size={16} />
          </IconButton>
          <IconButton title="Settings" onClick={() => setView('settings')}>
            <Icons.Settings size={16} />
          </IconButton>
        </div>
      </header>

      <AuthErrorBanner />
      <OfflineBanner />
      <UpdateBanner />
      {bootError ? (
        <div className="banner banner--warning" role="alert">
          <span className="banner__icon">
            <Icons.Warning size={15} />
          </span>
          <span className="banner__text">Could not load your mailboxes: {bootError}</span>
        </div>
      ) : null}

      {!ready ? (
        <div className="firstrun">
          <div className="firstrun__card">
            <Icons.Mail size={36} />
            <div className="firstrun__desc">Loading your mail…</div>
          </div>
        </div>
      ) : !showChrome && view === 'inbox' ? (
        <FirstRun />
      ) : (
        <div className="app-body">
          {navOpen || !narrow ? (
            <aside className="pane pane--nav">
              <ErrorBoundary label="The mailbox list crashed">
                <Nav onCompose={compose} />
              </ErrorBoundary>
            </aside>
          ) : null}
          {narrow && navOpen ? <div className="nav-scrim" onClick={() => setNavOpen(false)} /> : null}

          {view === 'inbox' ? (
            <>
              <div className="pane pane--list">
                <ErrorBoundary label="The conversation list crashed">
                  <ThreadList />
                </ErrorBoundary>
              </div>
              <div className="pane pane--reader">
                <ErrorBoundary label="The reader crashed">
                  <ThreadView threadId={selectedThreadId} />
                </ErrorBoundary>
              </div>
            </>
          ) : (
            <div className="pane pane--full">
              <ErrorBoundary label="This page crashed">
                {view === 'settings' ? <SettingsPage /> : <AccountsPage />}
              </ErrorBoundary>
            </div>
          )}
        </div>
      )}

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  )
}

export default function App(): ReactElement {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
