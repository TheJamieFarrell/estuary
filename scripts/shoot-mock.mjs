// Capture marketing screenshots of the renderer running on mock data.
//   npx vite --config vite.mock.config.ts --port 5179      (in another shell)
//   node_modules/electron/dist/electron.exe scripts/shoot-mock.mjs
// Writes docs/assets/inbox-dark.png, inbox-light.png (1440x900 @2x) and compose.png (882x482 @2x).
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.MOCK_URL ?? 'http://localhost:5179'
const out = join(process.cwd(), 'docs', 'assets')
app.commandLine.appendSwitch('force-device-scale-factor', '2')
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(url, w, h) {
  const win = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { offscreen: true } })
  const loaded = new Promise((r) => win.webContents.once('did-finish-load', r))
  win.loadURL(url).catch(() => undefined)
  await loaded
  await sleep(1200)
  return win
}

async function shot(win, file) {
  const img = await win.webContents.capturePage()
  writeFileSync(join(out, file), img.toPNG())
  console.log(file, `${img.getSize().width}x${img.getSize().height}`)
}

app.whenReady().then(async () => {
  try {
    const main = await open(`${base}/index.html`, 1440, 900)
    // Open the third conversation so the reader pane has content, force dark, then light.
    await main.webContents.executeJavaScript(`(async () => {
      const w = (ms) => new Promise((r) => setTimeout(r, ms))
      await w(400)
      const rows = document.querySelectorAll('.tl-row'); rows[2]?.click(); await w(900)
      const s = window.__estuaryStore ?? window.__unimailStore
      if (s) await s.getState().updateSettings({ theme: 'dark' })
      await w(500)
    })()`)
    await shot(main, 'inbox-dark.png')
    await main.webContents.executeJavaScript(`(async () => {
      const s = window.__estuaryStore ?? window.__unimailStore
      if (s) await s.getState().updateSettings({ theme: 'light' })
      await new Promise((r) => setTimeout(r, 700))
    })()`)
    await shot(main, 'inbox-light.png')
    main.destroy()

    const compose = await open(`${base}/compose.html`, 882, 482)
    await shot(compose, 'compose.png')
    compose.destroy()
  } catch (err) {
    console.error('FAILED', err)
  }
  app.quit()
})
