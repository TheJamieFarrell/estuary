/**
 * BrowserWindow lifecycle: the main inbox window, floating compose windows,
 * the renderer CSP, external-link routing, and the broadcast helper every other
 * shell module uses to push events at the renderer.
 */
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { AppSettings } from '@shared/types'
import type { IpcEvent, IpcEventPayload } from '@shared/ipc'
import { windowStateFile } from '@main/paths'

const scope = log.scope('windows')

export interface ComposeInit {
  accountId?: string
  mode?: 'new' | 'reply' | 'replyAll' | 'forward'
  messageId?: string
  draftId?: string
  mailto?: string
}

export interface WindowManager {
  createMainWindow(options?: { show?: boolean }): BrowserWindow
  getMainWindow(): BrowserWindow | null
  /** Create the main window if it is gone, then show + focus it. */
  showMainWindow(): BrowserWindow
  /** Tray click: hide when focused, show otherwise. */
  toggleMainWindow(): void
  createComposeWindow(init: ComposeInit): BrowserWindow
  /** Init payload for the compose window that owns this webContents id. */
  composeInitFor(webContentsId: number): ComposeInit | undefined
  /** Re-colour the Windows title bar overlay for the given theme setting. */
  applyTheme(theme: AppSettings['theme']): void
  broadcast<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void
  sendToMain<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void
  setQuitting(quitting: boolean): void
  isQuitting(): boolean
  /** Install the CSP + permission handlers on the default session. Call once, after `whenReady`. */
  installSessionHandlers(): void
}

const MAIN_DEFAULTS = { width: 1280, height: 820 }
const MIN_SIZE = { width: 900, height: 600 }
const TITLEBAR_HEIGHT = 40

/** Matches src/renderer/styles/tokens.css --bg / --fg. */
const OVERLAY = {
  light: { color: '#f6f7f9', symbolColor: '#1b1f27' },
  dark: { color: '#15171c', symbolColor: '#e6e8ee' }
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function isDev(): boolean {
  return !app.isPackaged || !!process.env.ELECTRON_RENDERER_URL
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

/** Dev: electron-vite's server. Prod: the built html next to out/main. */
function rendererEntry(page: 'index.html' | 'compose.html'): { url?: string; file?: string } {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) return { url: `${devUrl}/${page}` }
  return { file: join(__dirname, '../renderer', page) }
}

function loadPage(win: BrowserWindow, page: 'index.html' | 'compose.html'): void {
  const entry = rendererEntry(page)
  if (entry.url) void win.loadURL(entry.url)
  else void win.loadFile(entry.file!)
}

function readWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as Partial<WindowState>
    const width = Math.max(MIN_SIZE.width, Number(raw.width) || MAIN_DEFAULTS.width)
    const height = Math.max(MIN_SIZE.height, Number(raw.height) || MAIN_DEFAULTS.height)
    return {
      width,
      height,
      x: Number.isFinite(raw.x) ? raw.x : undefined,
      y: Number.isFinite(raw.y) ? raw.y : undefined,
      maximized: !!raw.maximized
    }
  } catch {
    return { ...MAIN_DEFAULTS }
  }
}

function writeWindowState(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return
    const bounds = win.isMaximized() || win.isMinimized() ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, maximized: win.isMaximized() }
    writeFileSync(windowStateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    scope.warn('could not persist window bounds', err)
  }
}

/** Send http(s) links to the system browser and refuse everything else. */
function routeExternalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    // Allow the initial load / dev-server HMR navigations within our own page.
    if (url === current) return
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    openExternalIfSafe(url)
  })
  // Never let an email spawn a webview.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

export function openExternalIfSafe(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      void shell.openExternal(url)
    } else {
      scope.warn('blocked external navigation to', parsed.protocol)
    }
  } catch {
    scope.warn('blocked malformed external url')
  }
}

export function createWindowManager(deps: { getSettings: () => AppSettings }): WindowManager {
  let mainWindow: BrowserWindow | null = null
  let quitting = false
  const composeInits = new Map<number, ComposeInit>()

  function resolvedTheme(theme: AppSettings['theme']): 'light' | 'dark' {
    if (theme === 'dark') return 'dark'
    if (theme === 'light') return 'light'
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  function overlayFor(theme: AppSettings['theme']): Electron.TitleBarOverlay {
    return { ...OVERLAY[resolvedTheme(theme)], height: TITLEBAR_HEIGHT }
  }

  function baseWebPreferences(kind: 'main' | 'compose'): Electron.WebPreferences {
    return {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [`--window-kind=${kind}`]
    }
  }

  function currentTheme(): AppSettings['theme'] {
    try {
      return deps.getSettings().theme
    } catch {
      return 'system'
    }
  }

  function createMainWindow(options?: { show?: boolean }): BrowserWindow {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    const state = readWindowState()
    const win = new BrowserWindow({
      ...state,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      backgroundColor: OVERLAY[resolvedTheme(currentTheme())].color,
      title: 'Estuary',
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayFor(currentTheme()),
      autoHideMenuBar: true,
      webPreferences: baseWebPreferences('main')
    })
    mainWindow = win

    if (state.maximized) win.maximize()

    win.once('ready-to-show', () => {
      if (options?.show === false) return
      win.show()
      win.focus()
    })

    let saveTimer: NodeJS.Timeout | undefined
    const scheduleSave = (): void => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => writeWindowState(win), 400)
    }
    win.on('resize', scheduleSave)
    win.on('move', scheduleSave)
    win.on('maximize', scheduleSave)
    win.on('unmaximize', scheduleSave)

    win.on('close', (event) => {
      writeWindowState(win)
      let minimizeToTray = true
      try {
        minimizeToTray = deps.getSettings().minimizeToTray
      } catch {
        /* settings unreadable: fall back to close-to-tray */
      }
      if (!quitting && minimizeToTray) {
        event.preventDefault()
        win.hide()
      }
    })

    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })

    routeExternalLinks(win)
    loadPage(win, 'index.html')
    return win
  }

  function showMainWindow(): BrowserWindow {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow()
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return win
  }

  function createComposeWindow(init: ComposeInit): BrowserWindow {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const win = new BrowserWindow({
      width: 760,
      height: 640,
      minWidth: 520,
      minHeight: 420,
      show: false,
      title: 'New message',
      backgroundColor: OVERLAY[resolvedTheme(currentTheme())].color,
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayFor(currentTheme()),
      autoHideMenuBar: true,
      // Deliberately not `parent`ed: compose floats beside the inbox instead of on top of it.
      webPreferences: baseWebPreferences('compose')
    })
    // Offset each new compose window slightly so they do not stack perfectly.
    if (parent) {
      const b = parent.getBounds()
      const offset = (composeInits.size % 5) * 24
      win.setPosition(
        Math.round(b.x + (b.width - 760) / 2) + offset,
        Math.round(b.y + (b.height - 640) / 2) + offset
      )
    }

    composeInits.set(win.webContents.id, init)
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => composeInits.delete(win.webContents.id))

    routeExternalLinks(win)
    loadPage(win, 'compose.html')
    return win
  }

  function applyTheme(theme: AppSettings['theme']): void {
    nativeTheme.themeSource = theme
    const overlay = overlayFor(theme)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.setTitleBarOverlay(overlay)
        win.setBackgroundColor(overlay.color as string)
      } catch {
        // setTitleBarOverlay is Windows-only; ignore elsewhere.
      }
    }
  }

  function broadcast<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(event, payload)
    }
  }

  function sendToMain<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const contents = mainWindow.webContents
    // A notification click can land before a freshly recreated window has its renderer up.
    if (contents.isLoading()) contents.once('did-finish-load', () => contents.send(event, payload))
    else contents.send(event, payload)
  }

  function installSessionHandlers(): void {
    const dev = isDev()
    // The reader renders sanitised email into an <iframe srcdoc>, which inherits this policy:
    // inline styles must stay legal, inline scripts must not. Remote images are allowed here and
    // gated in the renderer by the loadRemoteImages setting.
    const csp = [
      "default-src 'self'",
      dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "frame-src 'self' data: blob:",
      dev ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*" : "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // Only stamp documents; leaving other responses alone keeps main-process HTTP
      // (OAuth token exchange, autoconfig lookups) untouched.
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({})
        return
      }
      const headers = { ...details.responseHeaders }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') delete headers[key]
      }
      headers['Content-Security-Policy'] = [csp]
      callback({ responseHeaders: headers })
    })

    // Email content must never be able to ask for the camera, microphone, geolocation, etc.
    // "Copy address" needs clipboard write, and nothing else is legitimate here.
    const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(ALLOWED.has(permission))
    )
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
  }

  return {
    createMainWindow,
    getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    showMainWindow,
    toggleMainWindow(): void {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide()
      else showMainWindow()
    },
    createComposeWindow,
    composeInitFor: (id) => composeInits.get(id),
    applyTheme,
    broadcast,
    sendToMain,
    setQuitting: (v) => {
      quitting = v
    },
    isQuitting: () => quitting,
    installSessionHandlers
  }
}
