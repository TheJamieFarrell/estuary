/**
 * UniMail main entry.
 *
 * Boot order: paths -> logging -> store -> auth -> engine -> IPC -> menu -> tray -> window -> sync.
 * Teardown happens once, in `before-quit`.
 */
import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'

import { createMailStore } from '@main/db'
import { createMailEngine } from '@main/mail'
import { createAuthService } from '@main/auth'

import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AuthService, MailEngine, MailStore } from '@main/contracts'
import { getAppPaths } from '@main/paths'
import { createWindowManager } from '@main/windows'
import { createTray } from '@main/tray'
import { createNotifier } from '@main/notifications'
import { installAppMenu } from '@main/menu'
import { registerIpc } from '@main/ipc'
import type { IpcController } from '@main/ipc'
import { applyLoginItem, launchedHidden } from '@main/loginItem'
import { seedOAuthClients } from '@main/oauthSeed'
import { createUpdater } from '@main/updater'

const APP_USER_MODEL_ID = 'com.jamiefarrell.unimail'

app.setAppUserModelId(APP_USER_MODEL_ID)

// Dev/debug: run against a different data directory (and single-instance lock) than the installed app.
if (process.env.UNIMAIL_USER_DATA) app.setPath('userData', process.env.UNIMAIL_USER_DATA)

const paths = getAppPaths()

log.initialize()
log.transports.file.resolvePathFn = () => join(paths.logsDir, 'main.log')
log.transports.file.level = 'info'
log.transports.console.level = app.isPackaged ? false : 'debug'
const scope = log.scope('app')

// Unhandled failures must be logged, not fatal: a dead IMAP socket should never take the app down.
// (Deliberately our own handlers rather than electron-log's errorHandler, which can decide to quit.)
process.on('uncaughtException', (err) => scope.error('uncaught exception', err))
process.on('unhandledRejection', (reason) => scope.error('unhandled rejection', reason))

let store: MailStore | null = null
let engine: MailEngine | null = null
let auth: AuthService | null = null
let ipc: IpcController | null = null
let tearingDown = false

/** Settings reader that survives the store not being open yet. */
function readSettings(): AppSettings {
  try {
    return store?.getSettings() ?? DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

const windows = createWindowManager({ getSettings: readSettings })

function mailtoFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith('mailto:'))
}

// --- single instance --------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  scope.info('another instance is already running; exiting')
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const mailto = mailtoFromArgv(argv)
    if (mailto) {
      windows.createComposeWindow({ mailto, mode: 'new' })
      return
    }
    windows.showMainWindow()
  })

  // macOS delivers mailto: through open-url rather than argv.
  app.on('open-url', (event, url) => {
    if (!url.toLowerCase().startsWith('mailto:')) return
    event.preventDefault()
    windows.createComposeWindow({ mailto: url, mode: 'new' })
  })

  void app.whenReady().then(bootstrap)
}

async function bootstrap(): Promise<void> {
  try {
    // Registering the protocol handler from a dev build would point mailto: at electron.exe.
    if (app.isPackaged) app.setAsDefaultProtocolClient('mailto')

    windows.installSessionHandlers()

    const mailStore: MailStore = createMailStore()
    mailStore.open(paths.dbFile)
    store = mailStore
    scope.info(`store open at ${paths.dbFile}`)
    seedOAuthClients(mailStore)

    const authService: AuthService = createAuthService(mailStore)
    const mailEngine: MailEngine = createMailEngine(mailStore, authService, paths)
    auth = authService
    engine = mailEngine

    const settings = readSettings()
    nativeTheme.themeSource = settings.theme
    applyLoginItem(settings.startOnLogin)

    const notifier = createNotifier({ windows, getSettings: readSettings })

    const openCompose = (): void => {
      windows.createComposeWindow({ mode: 'new' })
    }
    const openSettings = (): void => {
      windows.showMainWindow()
      windows.sendToMain('nav:goto', { view: 'settings' })
    }
    const syncNow = (): void => {
      mailEngine.syncNow().catch((err) => scope.warn('manual sync failed', err))
    }

    const tray = createTray({
      windows,
      getSettings: readSettings,
      setSettings: (patch) => {
        const next = mailStore.setSettings(patch)
        if (!next) return
        if (patch.startOnLogin !== undefined) applyLoginItem(next.startOnLogin)
        if (patch.theme !== undefined) windows.applyTheme(next.theme)
        ipc?.broadcast('settings:changed', next)
      },
      onCompose: openCompose,
      onSyncNow: syncNow,
      onOpenSettings: openSettings
    })

    const updater = createUpdater({
      onAvailable: (info) => ipc?.broadcast('update:available', info),
      beforeInstall: () => windows.setQuitting(true)
    })

    ipc = registerIpc({
      store: mailStore,
      engine: mailEngine,
      auth: authService,
      windows,
      paths,
      tray,
      notifier,
      updater
    })
    if (app.isPackaged) updater.start()

    installAppMenu({ windows, onCompose: openCompose, onOpenSettings: openSettings, onSyncNow: syncNow })

    // Following the OS theme means re-colouring the title bar overlay when it flips.
    nativeTheme.on('updated', () => {
      if (readSettings().theme === 'system') windows.applyTheme('system')
    })

    const hidden = launchedHidden()
    const mailto = mailtoFromArgv(process.argv)
    windows.createMainWindow({ show: !hidden })
    if (mailto) windows.createComposeWindow({ mailto, mode: 'new' })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows.createMainWindow()
      else windows.showMainWindow()
    })

    await mailEngine.start()
    scope.info('mail engine started')
  } catch (err) {
    scope.error('bootstrap failed', err)
    throw err
  }
}

app.on('window-all-closed', () => {
  // With close-to-tray on, the app is expected to keep running with no windows.
  if (process.platform === 'darwin') return
  if (readSettings().minimizeToTray) return
  app.quit()
})

app.on('before-quit', (event) => {
  windows.setQuitting(true)
  if (tearingDown) return
  tearingDown = true
  event.preventDefault()
  void (async () => {
    try {
      ipc?.dispose()
    } catch (err) {
      scope.warn('ipc dispose failed', err)
    }
    try {
      await engine?.stop()
    } catch (err) {
      scope.warn('engine stop failed', err)
    }
    try {
      store?.close()
    } catch (err) {
      scope.warn('store close failed', err)
    }
    scope.info('shutdown complete')
    app.quit()
  })()
})
