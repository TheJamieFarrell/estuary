/**
 * Global renderer state (zustand). Single store; features select the slices they need.
 * Owned by the renderer-core agent. Other renderer code should read through the exported
 * selectors/actions rather than mutating state directly.
 */
import { create } from 'zustand'
import type {
  Account,
  AccountAuthErrorEvent,
  AppSettings,
  FolderKind,
  Folder,
  MessageAction,
  MessageListQuery,
  SyncStatus,
  ThreadSummary,
  UnreadCounts
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api, hasElectronApi } from './api'

export type AppView = 'inbox' | 'settings' | 'accounts'

/** What the thread list is currently showing. */
export interface MailView {
  /** 'unified' spans every account; 'account' is scoped to accountId. */
  kind: 'unified' | 'account'
  accountId?: string
  /** Folder kind (inbox/sent/…) — used for unified and for account folders without an id. */
  folderKind?: FolderKind
  /** Concrete folder id; wins over folderKind. */
  folderId?: string
  /** Virtual "Starred" view (no real folder on most providers). */
  starred?: boolean
  label: string
}

export interface ListFilters {
  unread: boolean
  starred: boolean
  attachments: boolean
}

export const UNIFIED_INBOX: MailView = { kind: 'unified', folderKind: 'inbox', label: 'Inbox' }

export interface AppState {
  // --- bootstrap ---
  ready: boolean
  bootError?: string

  // --- data ---
  accounts: Account[]
  folders: Folder[]
  unread: UnreadCounts
  settings: AppSettings
  syncStatuses: Record<string, SyncStatus>
  authErrors: Record<string, AccountAuthErrorEvent>

  // --- navigation ---
  view: AppView
  mailView: MailView
  navOpen: boolean
  collapsedAccounts: Record<string, boolean>

  // --- list ---
  threads: ThreadSummary[]
  nextCursor?: string
  total?: number
  listLoading: boolean
  listLoadingMore: boolean
  listError?: string
  filters: ListFilters

  // --- selection ---
  selectedThreadId?: string
  selectedIds: string[]
  anchorId?: string

  // --- search ---
  searchQuery: string
  searchActive: boolean

  // --- misc ui ---
  shortcutsOpen: boolean

  // --- actions ---
  init: () => Promise<void>
  setView: (view: AppView) => void
  setNavOpen: (open: boolean) => void
  toggleAccountCollapsed: (accountId: string) => void
  openMailView: (view: MailView) => void
  goToUnifiedInbox: () => void

  reloadAccounts: () => Promise<void>
  reloadFolders: () => Promise<void>
  reloadUnread: () => Promise<void>

  refreshList: (opts?: { silent?: boolean }) => Promise<void>
  loadMore: () => Promise<void>

  selectThread: (threadId: string | undefined) => void
  moveSelection: (delta: number) => void
  toggleChecked: (threadId: string, opts?: { range?: boolean }) => void
  clearChecked: () => void
  checkAll: () => void

  setFilter: (key: keyof ListFilters, value: boolean) => void
  toggleFilter: (key: keyof ListFilters) => void

  setSearchQuery: (q: string) => void
  runSearch: (q?: string) => Promise<void>
  clearSearch: () => void

  threadAction: (action: MessageAction, threadIds: string[], targetFolderId?: string) => Promise<void>
  syncNow: (accountId?: string) => Promise<void>

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  applyTheme: () => void

  setShortcutsOpen: (open: boolean) => void
  dismissAuthError: (accountId: string) => void
  /** Reported by features when an api call fails; the App surfaces it as a toast. */
  lastError?: { message: string; at: number }
  reportError: (message: string) => void
}

const EMPTY_UNREAD: UnreadCounts = { inbox: 0, byAccount: {}, byFolder: {} }

function buildQuery(state: AppState, cursor?: string): MessageListQuery {
  const { mailView, filters } = state
  const q: MessageListQuery = { limit: 50, cursor }
  if (mailView.kind === 'account' && mailView.accountId) q.accountId = mailView.accountId
  if (mailView.folderId) q.folderId = mailView.folderId
  else if (mailView.folderKind) q.folderKind = mailView.folderKind
  if (mailView.starred || filters.starred) q.starredOnly = true
  if (filters.unread) q.unreadOnly = true
  if (filters.attachments) q.withAttachments = true
  return q
}

let mediaQuery: MediaQueryList | undefined
let refreshTimer = 0

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  accounts: [],
  folders: [],
  unread: EMPTY_UNREAD,
  settings: DEFAULT_SETTINGS,
  syncStatuses: {},
  authErrors: {},

  view: 'inbox',
  mailView: UNIFIED_INBOX,
  navOpen: true,
  collapsedAccounts: {},

  threads: [],
  listLoading: false,
  listLoadingMore: false,
  filters: { unread: false, starred: false, attachments: false },

  selectedIds: [],

  searchQuery: '',
  searchActive: false,

  shortcutsOpen: false,

  async init() {
    try {
      const [accounts, settings, folders, unread, statuses] = await Promise.all([
        api.invoke('accounts:list', undefined),
        api.invoke('settings:get', undefined),
        api.invoke('folders:list', {}),
        api.invoke('folders:unreadCounts', undefined),
        api.invoke('sync:status', undefined)
      ])
      const syncStatuses: Record<string, SyncStatus> = {}
      for (const s of statuses) syncStatuses[s.accountId] = s
      set({ accounts, settings, folders, unread, syncStatuses, ready: true })
      get().applyTheme()
      await get().refreshList()
    } catch (err) {
      set({ ready: true, bootError: err instanceof Error ? err.message : String(err) })
    }

    // --- push events ---
    const scheduleRefresh = (): void => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        void get().refreshList({ silent: true })
        void get().reloadUnread()
      }, 250)
    }

    api.on('mail:changed', scheduleRefresh)
    api.on('mail:new', scheduleRefresh)
    api.on('sync:status', (status) => {
      set((s) => {
        const next: Partial<AppState> = { syncStatuses: { ...s.syncStatuses, [status.accountId]: status } }
        // A connection that is syncing or listening again has clearly re-authenticated.
        if ((status.state === 'syncing' || status.state === 'listening') && s.authErrors[status.accountId]) {
          const authErrors = { ...s.authErrors }
          delete authErrors[status.accountId]
          next.authErrors = authErrors
        }
        return next
      })
    })
    api.on('accounts:changed', ({ accounts }) => {
      set({ accounts })
      void get().reloadFolders()
      void get().refreshList({ silent: true })
    })
    api.on('folders:changed', () => {
      void get().reloadFolders()
      void get().reloadUnread()
    })
    api.on('settings:changed', (settings) => {
      set({ settings })
      get().applyTheme()
    })
    api.on('account:authError', (e) => {
      set((s) => ({ authErrors: { ...s.authErrors, [e.accountId]: e } }))
    })
    api.on('nav:goto', (payload) => {
      if (payload.view === 'settings' || payload.view === 'accounts') {
        set({ view: payload.view })
        return
      }
      set({ view: 'inbox' })
      if (payload.view === 'thread' && payload.threadId) {
        set({ selectedThreadId: payload.threadId, searchActive: false })
        void get().refreshList({ silent: true })
      } else if (payload.accountId) {
        get().openMailView({
          kind: 'account',
          accountId: payload.accountId,
          folderKind: 'inbox',
          label: 'Inbox'
        })
      } else {
        get().goToUnifiedInbox()
      }
    })

    if (typeof window !== 'undefined' && window.matchMedia) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', () => get().applyTheme())
    }
  },

  setView(view) {
    set({ view })
  },

  setNavOpen(navOpen) {
    set({ navOpen })
  },

  toggleAccountCollapsed(accountId) {
    set((s) => ({ collapsedAccounts: { ...s.collapsedAccounts, [accountId]: !s.collapsedAccounts[accountId] } }))
  },

  openMailView(mailView) {
    set({
      mailView,
      view: 'inbox',
      searchActive: false,
      threads: [],
      nextCursor: undefined,
      selectedThreadId: undefined,
      selectedIds: [],
      anchorId: undefined
    })
    void get().refreshList()
  },

  goToUnifiedInbox() {
    get().openMailView(UNIFIED_INBOX)
  },

  async reloadAccounts() {
    const accounts = await api.invoke('accounts:list', undefined)
    set({ accounts })
  },

  async reloadFolders() {
    const folders = await api.invoke('folders:list', {})
    set({ folders })
  },

  async reloadUnread() {
    try {
      const unread = await api.invoke('folders:unreadCounts', undefined)
      set({ unread })
    } catch {
      /* non-fatal */
    }
  },

  async refreshList(opts) {
    const state = get()
    if (state.searchActive) {
      await get().runSearch(state.searchQuery)
      return
    }
    if (!opts?.silent) set({ listLoading: true, listError: undefined })
    try {
      const res = await api.invoke('messages:list', buildQuery(get()))
      set({
        threads: res.threads,
        nextCursor: res.nextCursor,
        total: res.total,
        listLoading: false,
        listError: undefined
      })
      // Drop checked ids that are no longer in the list
      const ids = new Set(res.threads.map((t) => t.id))
      const kept = get().selectedIds.filter((id) => ids.has(id))
      if (kept.length !== get().selectedIds.length) set({ selectedIds: kept })
    } catch (err) {
      set({ listLoading: false, listError: err instanceof Error ? err.message : String(err) })
    }
  },

  async loadMore() {
    const { nextCursor, listLoadingMore, searchActive, searchQuery, threads } = get()
    if (!nextCursor || listLoadingMore) return
    set({ listLoadingMore: true })
    try {
      const res = searchActive
        ? await api.invoke('search:query', {
            q: searchQuery,
            accountId: get().mailView.kind === 'account' ? get().mailView.accountId : undefined,
            limit: 50,
            cursor: nextCursor
          })
        : await api.invoke('messages:list', buildQuery(get(), nextCursor))
      const seen = new Set(threads.map((t) => t.id))
      const merged = threads.concat(res.threads.filter((t) => !seen.has(t.id)))
      set({ threads: merged, nextCursor: res.nextCursor, listLoadingMore: false })
    } catch (err) {
      set({ listLoadingMore: false, listError: err instanceof Error ? err.message : String(err) })
    }
  },

  selectThread(threadId) {
    set({ selectedThreadId: threadId, anchorId: threadId ?? get().anchorId })
  },

  moveSelection(delta) {
    const { threads, selectedThreadId } = get()
    if (threads.length === 0) return
    const at = selectedThreadId ? threads.findIndex((t) => t.id === selectedThreadId) : -1
    const next = Math.min(threads.length - 1, Math.max(0, at < 0 ? (delta > 0 ? 0 : threads.length - 1) : at + delta))
    set({ selectedThreadId: threads[next].id, anchorId: threads[next].id })
  },

  toggleChecked(threadId, opts) {
    const { selectedIds, threads, anchorId } = get()
    if (opts?.range && anchorId) {
      const a = threads.findIndex((t) => t.id === anchorId)
      const b = threads.findIndex((t) => t.id === threadId)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = threads.slice(lo, hi + 1).map((t) => t.id)
        const merged = Array.from(new Set([...selectedIds, ...range]))
        set({ selectedIds: merged })
        return
      }
    }
    const has = selectedIds.includes(threadId)
    set({
      selectedIds: has ? selectedIds.filter((id) => id !== threadId) : [...selectedIds, threadId],
      anchorId: threadId
    })
  },

  clearChecked() {
    set({ selectedIds: [] })
  },

  checkAll() {
    set((s) => ({ selectedIds: s.threads.map((t) => t.id) }))
  },

  setFilter(key, value) {
    set((s) => ({ filters: { ...s.filters, [key]: value } }))
    void get().refreshList()
  },

  toggleFilter(key) {
    const cur = get().filters[key]
    get().setFilter(key, !cur)
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery })
  },

  async runSearch(q) {
    const query = (q ?? get().searchQuery).trim()
    if (!query) {
      get().clearSearch()
      return
    }
    set({ searchQuery: query, searchActive: true, listLoading: true, listError: undefined })
    try {
      const res = await api.invoke('search:query', {
        q: query,
        accountId: get().mailView.kind === 'account' ? get().mailView.accountId : undefined,
        limit: 50
      })
      set({ threads: res.threads, nextCursor: res.nextCursor, total: res.total, listLoading: false })
    } catch (err) {
      set({ listLoading: false, listError: err instanceof Error ? err.message : String(err) })
    }
  },

  clearSearch() {
    set({ searchQuery: '', searchActive: false })
    void get().refreshList()
  },

  async threadAction(action, threadIds, targetFolderId) {
    const { threads } = get()
    const set2 = new Set(threadIds)
    const messageIds = threads.filter((t) => set2.has(t.id)).flatMap((t) => t.messageIds)
    if (messageIds.length === 0) return

    const removes = action === 'archive' || action === 'trash' || action === 'spam' || action === 'deletePermanently' || action === 'move'

    // Optimistic local update
    const nextSelected = (): string | undefined => {
      const cur = get().selectedThreadId
      if (!cur || !set2.has(cur)) return cur
      const idx = threads.findIndex((t) => t.id === cur)
      const rest = threads.filter((t) => !set2.has(t.id))
      if (rest.length === 0) return undefined
      return (rest[Math.min(idx, rest.length - 1)] ?? rest[rest.length - 1]).id
    }

    set((s) => ({
      threads: removes
        ? s.threads.filter((t) => !set2.has(t.id))
        : s.threads.map((t) => {
            if (!set2.has(t.id)) return t
            if (action === 'markRead') return { ...t, unreadCount: 0 }
            if (action === 'markUnread') return { ...t, unreadCount: Math.max(1, t.unreadCount) }
            if (action === 'star') return { ...t, hasStarred: true }
            if (action === 'unstar') return { ...t, hasStarred: false }
            return t
          }),
      selectedThreadId: removes ? nextSelected() : s.selectedThreadId,
      selectedIds: s.selectedIds.filter((id) => !set2.has(id))
    }))

    try {
      await api.invoke('messages:action', { action, messageIds, targetFolderId })
      void get().reloadUnread()
    } catch (err) {
      get().reportError(err instanceof Error ? err.message : String(err))
      void get().refreshList({ silent: true })
    }
  },

  async syncNow(accountId) {
    try {
      await api.invoke('sync:now', { accountId })
    } catch (err) {
      get().reportError(err instanceof Error ? err.message : String(err))
    }
  },

  async updateSettings(patch) {
    try {
      const settings = await api.invoke('settings:set', patch)
      set({ settings })
      get().applyTheme()
    } catch (err) {
      get().reportError(err instanceof Error ? err.message : String(err))
    }
  },

  applyTheme() {
    if (typeof document === 'undefined') return
    const { theme, density } = get().settings
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false
    const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.density = density
  },

  setShortcutsOpen(shortcutsOpen) {
    set({ shortcutsOpen })
  },

  dismissAuthError(accountId) {
    set((s) => {
      const next = { ...s.authErrors }
      delete next[accountId]
      return { authErrors: next }
    })
  },

  reportError(message) {
    set({ lastError: { message, at: Date.now() } })
  }
}))

// Browser-only dev convenience: when there is no Electron bridge (plain `vite`), expose the
// store so the UI can be poked from the console. Never exposed inside the app itself.
if (typeof window !== 'undefined' && !hasElectronApi()) {
  ;(window as unknown as { __unimailStore?: typeof useStore }).__unimailStore = useStore
}

// ---------------------------------------------------------------------------
// Selectors / derived helpers
// ---------------------------------------------------------------------------

export function selectAccount(state: AppState, accountId?: string): Account | undefined {
  return state.accounts.find((a) => a.id === accountId)
}

export function selectFoldersForAccount(state: AppState, accountId: string): Folder[] {
  return state.folders.filter((f) => f.accountId === accountId)
}

export function selectFolder(state: AppState, folderId?: string): Folder | undefined {
  return folderId ? state.folders.find((f) => f.id === folderId) : undefined
}

/**
 * All addresses that belong to the user; used to render 'me'.
 * Cached by the accounts array identity so it is safe to use as a zustand selector.
 */
let meCacheKey: Account[] | undefined
let meCacheValue: string[] = []
export function selectMeAddresses(state: AppState): string[] {
  if (meCacheKey !== state.accounts) {
    meCacheKey = state.accounts
    meCacheValue = state.accounts.map((a) => a.email)
  }
  return meCacheValue
}

export function selectSelectedThread(state: AppState): ThreadSummary | undefined {
  return state.threads.find((t) => t.id === state.selectedThreadId)
}

/** true when every enabled account reports 'offline'. */
export function selectIsOffline(state: AppState): boolean {
  const enabled = state.accounts.filter((a) => a.enabled)
  if (enabled.length === 0) return false
  return enabled.every((a) => state.syncStatuses[a.id]?.state === 'offline')
}

export function selectIsSyncing(state: AppState): boolean {
  return Object.values(state.syncStatuses).some((s) => s.state === 'syncing' || s.state === 'connecting')
}

/** Unread count for a nav entry. */
export function selectUnreadFor(state: AppState, view: MailView): number {
  if (view.folderId) return state.unread.byFolder[view.folderId] ?? 0
  if (view.kind === 'unified' && view.folderKind === 'inbox') return state.unread.inbox
  if (view.kind === 'account' && view.accountId && view.folderKind === 'inbox') {
    return state.unread.byAccount[view.accountId] ?? 0
  }
  return 0
}

export function mailViewEquals(a: MailView, b: MailView): boolean {
  return (
    a.kind === b.kind &&
    a.accountId === b.accountId &&
    a.folderId === b.folderId &&
    a.folderKind === b.folderKind &&
    !!a.starred === !!b.starred
  )
}
