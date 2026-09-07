/**
 * Generates the Estuary app / tray icons with zero dependencies.
 *
 *   node scripts/gen-icons.mjs
 *
 * Writes resources/icon.png (256), resources/tray.png (32) and
 * resources/tray-unread.png (32, red dot). Everything is rasterised by hand into an
 * RGBA buffer at 4x and box-downsampled, then encoded as a PNG using only `zlib`.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'resources')

const BLUE = [0x2f, 0x6f, 0xed, 255]
const WHITE = [0xff, 0xff, 0xff, 255]
const RED = [0xe5, 0x48, 0x4d, 255]
const CLEAR = [0, 0, 0, 0]

// --- tiny raster surface ----------------------------------------------------

function surface(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) }
}

/** source-over composite of a straight-alpha colour */
function blend(s, x, y, [r, g, b, a], coverage = 1) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return
  const alpha = (a / 255) * coverage
  if (alpha <= 0) return
  const i = (y * s.w + x) * 4
  const da = s.data[i + 3] / 255
  const oa = alpha + da * (1 - alpha)
  if (oa <= 0) return
  s.data[i] = (r * alpha + s.data[i] * da * (1 - alpha)) / oa
  s.data[i + 1] = (g * alpha + s.data[i + 1] * da * (1 - alpha)) / oa
  s.data[i + 2] = (b * alpha + s.data[i + 2] * da * (1 - alpha)) / oa
  s.data[i + 3] = oa * 255
}

/** overwrite (used to punch a transparent gap around the badge) */
function poke(s, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return
  const i = (y * s.w + x) * 4
  s.data[i] = r
  s.data[i + 1] = g
  s.data[i + 2] = b
  s.data[i + 3] = a
}

function fillRect(s, x, y, w, h, colour) {
  for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++)
    for (let xx = Math.floor(x); xx < Math.ceil(x + w); xx++) blend(s, xx, yy, colour)
}

function fillRoundRect(s, x, y, w, h, r, colour) {
  const x1 = x + w
  const y1 = y + h
  for (let yy = Math.floor(y); yy < Math.ceil(y1); yy++) {
    for (let xx = Math.floor(x); xx < Math.ceil(x1); xx++) {
      const cx = xx < x + r ? x + r : xx > x1 - r ? x1 - r : xx
      const cy = yy < y + r ? y + r : yy > y1 - r ? y1 - r : yy
      const dx = xx - cx
      const dy = yy - cy
      if (dx * dx + dy * dy <= r * r) blend(s, xx, yy, colour)
    }
  }
}

function fillCircle(s, cx, cy, r, colour, write = false) {
  for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
    for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
      const dx = xx - cx
      const dy = yy - cy
      if (dx * dx + dy * dy <= r * r) (write ? poke : blend)(s, xx, yy, colour)
    }
  }
}

function fillTriangle(s, [ax, ay], [bx, by], [cx, cy], colour) {
  const minX = Math.floor(Math.min(ax, bx, cx))
  const maxX = Math.ceil(Math.max(ax, bx, cx))
  const minY = Math.floor(Math.min(ay, by, cy))
  const maxY = Math.ceil(Math.max(ay, by, cy))
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (area === 0) return
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area
      const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / area
      const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / area
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) blend(s, x, y, colour)
    }
  }
}

/** box-downsample by an integer factor (our cheap anti-aliasing) */
function downsample(s, factor) {
  const out = surface(s.w / factor, s.h / factor)
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * s.w + (x * factor + sx)) * 4
          const sa = s.data[i + 3] / 255
          r += s.data[i] * sa
          g += s.data[i + 1] * sa
          b += s.data[i + 2] * sa
          a += sa
        }
      }
      const i = (y * out.w + x) * 4
      out.data[i] = a > 0 ? r / a : 0
      out.data[i + 1] = a > 0 ? g / a : 0
      out.data[i + 2] = a > 0 ? b / a : 0
      out.data[i + 3] = (a / (factor * factor)) * 255
    }
  }
  return out
}

// --- PNG encoder ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([len, typed, crc])
}

function encodePng(s) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(s.w, 0)
  ihdr.writeUInt32BE(s.h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(s.h * (s.w * 4 + 1))
  for (let y = 0; y < s.h; y++) {
    raw[y * (s.w * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < s.w * 4; x++) raw[y * (s.w * 4 + 1) + 1 + x] = s.data[y * s.w * 4 + x]
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- the artwork ------------------------------------------------------------

/** flat envelope on a blue rounded square, drawn in a `size` x `size` box */
function drawLogo(size, unread) {
  const S = 4 // supersample
  const n = size * S
  const s = surface(n, n)
  const pad = n * 0.05
  const box = n - pad * 2
  fillRoundRect(s, pad, pad, box, box, box * 0.22, BLUE)

  // envelope body
  const ew = box * 0.6
  const eh = ew * 0.68
  const ex = pad + (box - ew) / 2
  const ey = pad + (box - eh) / 2 + box * 0.01
  fillRoundRect(s, ex, ey, ew, eh, Math.max(1, box * 0.03), WHITE)

  // flap: a blue V cut out of the top of the body
  fillTriangle(s, [ex, ey], [ex + ew, ey], [ex + ew / 2, ey + eh * 0.62], BLUE)
  // thin white rule under the flap so the fold reads at small sizes
  fillTriangle(s, [ex, ey], [ex + ew, ey], [ex + ew / 2, ey + eh * 0.62 - box * 0.045], WHITE)
  fillTriangle(
    s,
    [ex + box * 0.02, ey],
    [ex + ew - box * 0.02, ey],
    [ex + ew / 2, ey + eh * 0.62 - box * 0.075],
    BLUE
  )

  const out = downsample(s, S)
  if (unread) {
    const r = size * 0.24
    const cx = size - r - size * 0.04
    const cy = size - r - size * 0.04
    fillCircle(out, cx, cy, r * 1.32, CLEAR, true) // transparent gap
    fillCircle(out, cx, cy, r, RED)
  }
  return out
}

mkdirSync(OUT, { recursive: true })
const targets = [
  ['icon.png', 256, false],
  ['tray.png', 32, false],
  ['tray-unread.png', 32, true]
]
for (const [name, size, unread] of targets) {
  const png = encodePng(drawLogo(size, unread))
  writeFileSync(join(OUT, name), png)
  console.log(`wrote resources/${name} (${size}x${size}, ${png.length} bytes)`)
}
