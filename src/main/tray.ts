/**
 * System tray icon: quick actions, unread badge, and the Windows taskbar overlay icon.
 * The badge is drawn by hand into a BGRA bitmap so we do not need an image library.
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { AppSettings } from '@shared/types'
import { getResourcesDir } from '@main/paths'
import type { WindowManager } from '@main/windows'

const scope = log.scope('tray')

export interface TrayController {
  /** Swap the tray icon and refresh the taskbar overlay badge. */
  setUnread(count: number): void
  /** Rebuild the context menu (checkbox state follows settings). */
  refresh(): void
  destroy(): void
}

export interface TrayDeps {
  windows: WindowManager
  getSettings(): AppSettings
  setSettings(patch: Partial<AppSettings>): void
  onCompose(): void
  onSyncNow(): void
  onOpenSettings(): void
}

// A 3x5 bitmap font: just enough to render "1".."99" and "9+" on the badge.
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/**
 * Draws a red circle with the count in white. Electron wants premultiplied BGRA.
 */
function makeBadge(count: number): NativeImage {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    const alpha = a / 255
    buf[i] = Math.round(b * alpha)
    buf[i + 1] = Math.round(g * alpha)
    buf[i + 2] = Math.round(r * alpha)
    buf[i + 3] = a
  }

  const cx = size / 2 - 0.5
  const cy = size / 2 - 0.5
  const radius = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy)
      // 1px of feathering so the circle does not look jagged in the taskbar.
      const coverage = Math.max(0, Math.min(1, radius - d))
      if (coverage > 0) put(x, y, 0xe5, 0x48, 0x4d, Math.round(255 * coverage))
    }
  }

  const label = count > 99 ? '9+' : String(count)
  const scale = label.length > 1 ? 3 : 4
  const glyphW = 3 * scale
  const gap = scale
  const textW = label.length * glyphW + (label.length - 1) * gap
  const textH = 5 * scale
  const ox = Math.round((size - textW) / 2)
  const oy = Math.round((size - textH) / 2)

  label.split('').forEach((ch, index) => {
    const rows = GLYPHS[ch] ?? GLYPHS['+']
    const baseX = ox + index * (glyphW + gap)
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== '1') continue
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            put(baseX + rx * scale + sx, oy + ry * scale + sy, 255, 255, 255, 255)
          }
        }
      }
    })
  })

  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export function createTray(deps: TrayDeps): TrayController {
  const iconPath = (name: string): string => join(getResourcesDir(), name)
  let tray: Tray | null = null
  let unread = 0

  const icon = (name: string): NativeImage => {
    const image = nativeImage.createFromPath(iconPath(name))
    return image.isEmpty() ? nativeImage.createEmpty() : image
  }

  try {
    tray = new Tray(icon('tray.png'))
  } catch (err) {
    scope.error('could not create tray icon', err)
    return { setUnread: () => {}, refresh: () => {}, destroy: () => {} }
  }

  tray.setToolTip('Estuary')
  tray.on('click', () => deps.windows.toggleMainWindow())
  tray.on('double-click', () => deps.windows.showMainWindow())

  function buildMenu(): void {
    if (!tray) return
    let startOnLogin = false
    try {
      startOnLogin = deps.getSettings().startOnLogin
    } catch {
      /* settings not readable yet */
    }
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: unread > 0 ? `Estuary - ${unread} unread` : 'Estuary', enabled: false },
        { type: 'separator' },
        { label: 'Open Estuary', click: () => deps.windows.showMainWindow() },
        { label: 'New message', accelerator: 'CmdOrCtrl+N', click: () => deps.onCompose() },
        { label: 'Sync now', click: () => deps.onSyncNow() },
        { type: 'separator' },
        { label: 'Settings', click: () => deps.onOpenSettings() },
        {
          label: 'Start on login',
          type: 'checkbox',
          checked: startOnLogin,
          click: (item) => deps.setSettings({ startOnLogin: item.checked })
        },
        { type: 'separator' },
        { label: 'Quit Estuary', click: () => app.quit() }
      ])
    )
  }

  function setUnread(count: number): void {
    unread = Math.max(0, Math.floor(count) || 0)
    if (!tray) return
    tray.setImage(icon(unread > 0 ? 'tray-unread.png' : 'tray.png'))
    tray.setToolTip(unread > 0 ? `Estuary - ${unread} unread` : 'Estuary')
    buildMenu()

    const win = deps.windows.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (process.platform === 'win32') {
      if (unread > 0) win.setOverlayIcon(makeBadge(unread), `${unread} unread messages`)
      else win.setOverlayIcon(null, '')
    } else if (app.dock) {
      app.dock.setBadge(unread > 0 ? String(unread) : '')
    }
  }

  buildMenu()

  return {
    setUnread,
    refresh: buildMenu,
    destroy: () => {
      tray?.destroy()
      tray = null
    }
  }
}
