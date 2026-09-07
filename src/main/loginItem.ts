/**
 * "Start Estuary when I sign in". The auto-started copy launches with `--hidden`
 * so it goes straight to the tray instead of popping the inbox open on boot.
 */
import { app } from 'electron'
import log from 'electron-log/main'

const scope = log.scope('loginItem')

export const HIDDEN_FLAG = '--hidden'

export function applyLoginItem(enabled: boolean): void {
  // In dev the exe is electron.exe inside node_modules; registering that would be useless
  // and would litter the user's startup list.
  if (!app.isPackaged) {
    scope.info(`skipping login item in dev (would have set openAtLogin=${enabled})`)
    return
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [HIDDEN_FLAG]
    })
  } catch (err) {
    scope.warn('could not update login item', err)
  }
}

export function isLoginItemEnabled(): boolean {
  try {
    return app.getLoginItemSettings({ path: process.execPath, args: [HIDDEN_FLAG] }).openAtLogin
  } catch {
    return false
  }
}

/** True when this process was started by the login item (or with --hidden by hand). */
export function launchedHidden(argv: string[] = process.argv): boolean {
  return argv.includes(HIDDEN_FLAG)
}
