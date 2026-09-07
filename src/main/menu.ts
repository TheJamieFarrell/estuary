/**
 * Application menu. The window uses `titleBarStyle: 'hidden'` and `autoHideMenuBar`,
 * so this is mostly here for the accelerators (and Alt to peek at it).
 */
import { app, dialog, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { WindowManager } from '@main/windows'

export interface MenuDeps {
  windows: WindowManager
  onCompose(): void
  onOpenSettings(): void
  onSyncNow(): void
}

export function buildAppMenu(deps: MenuDeps): Menu {
  const isDev = !app.isPackaged

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'New message', accelerator: 'CmdOrCtrl+N', click: () => deps.onCompose() },
        { label: 'Sync now', accelerator: 'F5', click: () => deps.onSyncNow() },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => deps.onOpenSettings() },
        { type: 'separator' },
        { label: 'Close window', accelerator: 'CmdOrCtrl+W', role: 'close' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '&View',
      submenu: [
        ...(isDev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' }
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About Estuary',
          click: () => {
            const win = deps.windows.getMainWindow()
            const detail = [
              `Version ${app.getVersion()}`,
              `Electron ${process.versions.electron}`,
              `Chromium ${process.versions.chrome}`,
              `Node ${process.versions.node}`
            ].join('\n')
            const options = {
              type: 'info' as const,
              title: 'About Estuary',
              message: 'Estuary',
              detail: `${detail}\n\nGmail, Outlook, Spacemail and any IMAP account in one inbox.`,
              buttons: ['OK']
            }
            if (win) void dialog.showMessageBox(win, options)
            else void dialog.showMessageBox(options)
          }
        },
        {
          label: 'Open logs folder',
          click: () => {
            void shell.openPath(app.getPath('logs'))
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function installAppMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(buildAppMenu(deps))
}
