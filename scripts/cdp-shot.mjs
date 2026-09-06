// Dev helper: screenshot / evaluate JS in a running UniMail started with --remote-debugging-port=9333
// usage: node scripts/cdp-shot.mjs shot out.png [titleFilter]   |   node scripts/cdp-shot.mjs eval "<js>" [titleFilter]
const [, , cmd, arg, filter = ''] = process.argv
const port = process.env.CDP_PORT || '9333'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const pages = targets.filter((t) => t.type === 'page' && (t.url.includes(filter) || t.title.includes(filter)))
if (!pages.length) { console.error('no page targets', targets.map((t) => t.url)); process.exit(1) }
const target = pages[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
await new Promise((r) => (ws.onopen = r))
if (cmd === 'shot') {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('saved', arg, target.url)
} else if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result.value ?? r.result, null, 1))
  if (r.exceptionDetails) console.error(JSON.stringify(r.exceptionDetails))
}
ws.close()
