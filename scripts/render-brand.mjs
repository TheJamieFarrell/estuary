// Rasterise the brand SVGs with Electron's own Chromium (no native image deps).
//   node_modules/electron/dist/electron.exe scripts/render-brand.mjs
// Produces the app icon, tray icons, favicons and the social image from docs/brand/*.svg.
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const brand = join(root, 'docs', 'brand')
const mark = readFileSync(join(brand, 'estuary-mark.svg'), 'utf8')
const mono = readFileSync(join(brand, 'estuary-mark-mono.svg'), 'utf8')

const page = (body, w, h, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}svg{display:block}</style></head><body>${body}</body></html>`

const sized = (svg, size, color) =>
  svg
    .replace(/width="100" height="100"/, `width="${size}" height="${size}"`)
    .replace('<svg ', color ? `<svg style="color:${color}" ` : '<svg ')

const jobs = [
  { out: 'resources/icon.png', w: 256, h: 256, html: sized(mark, 256) },
  { out: 'resources/icon-512.png', w: 512, h: 512, html: sized(mark, 512) },
  { out: 'docs/assets/icon.png', w: 256, h: 256, html: sized(mark, 256) },
  { out: 'docs/assets/icon-512.png', w: 512, h: 512, html: sized(mark, 512) },
  { out: 'docs/assets/favicon-32.png', w: 32, h: 32, html: sized(mark, 32) },
  { out: 'docs/assets/favicon-192.png', w: 192, h: 192, html: sized(mark, 192) },
  { out: 'resources/tray.png', w: 32, h: 32, html: sized(mono, 32, '#e8ecf4') },
  {
    out: 'resources/tray-unread.png',
    w: 32,
    h: 32,
    html: sized(mono, 32, '#e8ecf4') + `<svg style="position:absolute;left:0;top:0" width="32" height="32"><circle cx="25" cy="7" r="6.5" fill="#e5484d" stroke="#15171c" stroke-width="2"/></svg>`
  }
]

// Optional extra jobs: `--og docs/brand/og.html` renders that page at 1200x630 to docs/assets/og-image.png
const ogIdx = process.argv.indexOf('--og')
if (ogIdx > -1 && process.argv[ogIdx + 1]) {
  jobs.push({ out: 'docs/assets/og-image.png', w: 1200, h: 630, file: join(root, process.argv[ogIdx + 1]), bg: '#0b1224' })
}

// Render at exactly 1 CSS px = 1 device px regardless of the monitor's scaling.
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('high-dpi-support', '1')

// Destroying a render window must not end the process before the next job.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  for (const job of jobs) {
    try {
      await render(job)
    } catch (err) {
      console.error(`FAILED ${job.out}:`, err && err.message ? err.message : err)
    }
  }
  app.quit()
})

async function render(job) {
  {
    const win = new BrowserWindow({
      show: false,
      width: job.w,
      height: job.h,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true }
    })
    win.webContents.setZoomFactor(1)
    const html = job.file ? readFileSync(job.file, 'utf8') : page(job.html, job.w, job.h, job.bg)
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    if (job.file) win.loadFile(job.file).catch(() => undefined)
    else win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => undefined)
    await loaded
    await new Promise((r) => setTimeout(r, 300))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: job.w, height: job.h })
    const outPath = join(root, job.out)
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(outPath, image.toPNG())
    console.log(`${job.out}  ${image.getSize().width}x${image.getSize().height}`)
    win.destroy()
  }
}
