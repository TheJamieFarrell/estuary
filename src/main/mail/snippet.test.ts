import { describe, expect, it } from 'vitest'
import { makeSnippet, snippetFromPartialText } from './parse'

describe('snippetFromPartialText', () => {
  it('reads a single-part quoted-printable plain body', () => {
    const raw = Buffer.from('Hello Jamie,=0D=0A=0D=0AYour order has shipped =E2=80=94 see below.=\r\n Thanks!', 'latin1')
    const out = snippetFromPartialText(raw, { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } })
    expect(out).toBe('Hello Jamie, Your order has shipped — see below. Thanks!')
  })

  it('prefers text/plain inside multipart/alternative and tolerates truncation', () => {
    const boundary = 'b1'
    const text =
      `--${boundary}\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n` +
      `Get 20% off when you upgrade today.\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n<html><body><p>Get 20%` // cut mid-tag
    const out = snippetFromPartialText(Buffer.from(text, 'latin1'), {
      type: 'multipart/alternative',
      parameters: { boundary }
    })
    expect(out).toBe('Get 20% off when you upgrade today.')
  })

  it('falls back to html and strips tags, links and preheader padding', () => {
    const boundary = 'xyz'
    const text =
      `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      Buffer.from('<div style="display:none">&zwnj;&zwnj;&zwnj;</div><p>See what <b>bianca</b> posted https://www.insta.example/x </p><p>More', 'utf8').toString('base64')
    const out = snippetFromPartialText(Buffer.from(text, 'latin1'), { type: 'multipart/mixed', parameters: { boundary } })
    expect(out).toBe('See what bianca posted More')
  })

  it('walks nested multipart/related > multipart/alternative', () => {
    const outer = 'outer'
    const inner = 'inner'
    const text =
      `--${outer}\r\nContent-Type: multipart/alternative; boundary="${inner}"\r\n\r\n` +
      `--${inner}\r\nContent-Type: text/plain\r\n\r\nNested plain text here\r\n--${inner}\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--${inner}--\r\n` +
      `--${outer}\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\n\r\nPNGDATA\r\n--${outer}--`
    const out = snippetFromPartialText(Buffer.from(text, 'latin1'), { type: 'multipart/related', parameters: { boundary: outer } })
    expect(out).toBe('Nested plain text here')
  })

  it('returns empty for missing input', () => {
    expect(snippetFromPartialText(undefined, { type: 'text/plain' })).toBe('')
    expect(snippetFromPartialText(Buffer.alloc(0), { type: 'text/plain' })).toBe('')
  })
})

describe('makeSnippet link stripping', () => {
  it('drops bracketed tracking links', () => {
    expect(makeSnippet({ text: '[https://l7l8jwcn.r.us-west-2.awstrack.me/I0/010] &Barr just posted a match' })).toBe(
      '&Barr just posted a match'
    )
  })
})
