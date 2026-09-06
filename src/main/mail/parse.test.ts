import { describe, expect, it } from 'vitest'
import {
  flattenStructure,
  hasAttachments,
  htmlToText,
  makeSnippet,
  parseFlags,
  parseHeaderBlock,
  parseMessageSource,
  parseReferences,
  safeFilename,
  stripAngles,
  toMessageUpsert,
  type ImapBodyStructure
} from './parse'

const crlf = (lines: string[]): string => lines.join('\r\n')

const PLAIN_MESSAGE = crlf([
  'Return-Path: <newsletter@example.com>',
  'From: "Ada Lovelace" <ada@example.com>',
  'To: Jamie <jamie@unimail.test>, Second <second@unimail.test>',
  'Cc: cc@unimail.test',
  'Subject: Weekly digest',
  'Date: Tue, 02 Sep 2025 10:11:12 +0000',
  'Message-ID: <plain-1@example.com>',
  'In-Reply-To: <parent-1@example.com>',
  'References: <root-1@example.com> <parent-1@example.com>',
  'List-Unsubscribe: <https://example.com/unsub>, <mailto:unsub@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '   Hello   there,',
  '',
  'this   is a  plain text message with     lots of whitespace.',
  '> quoted line that should not lead the snippet',
  ''
])

const BOUNDARY = 'unimail-boundary-42'

const MIXED_MESSAGE = crlf([
  'From: Bob <bob@example.com>',
  'To: jamie@unimail.test',
  'Subject: Invoice and logo',
  'Date: Wed, 03 Sep 2025 08:00:00 +0000',
  'Message-ID: <mixed-1@example.com>',
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
  '',
  `--${BOUNDARY}`,
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Hi <b>Jamie</b>,</p><p>invoice attached.</p><img src="cid:logo123"></body></html>',
  '',
  `--${BOUNDARY}`,
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo123>',
  'Content-Disposition: inline; filename="logo.png"',
  '',
  'iVBORw0KGgo=',
  '',
  `--${BOUNDARY}`,
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  '',
  'JVBERi0xLjQK',
  '',
  `--${BOUNDARY}--`,
  ''
])

const MIXED_STRUCTURE: ImapBodyStructure = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/html', size: 120 },
    {
      part: '2',
      type: 'image/png',
      id: '<logo123>',
      disposition: 'inline',
      dispositionParameters: { filename: 'logo.png' },
      size: 64
    },
    {
      part: '3',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'invoice.pdf' },
      size: 2048
    }
  ]
}

describe('small helpers', () => {
  it('strips angle brackets', () => {
    expect(stripAngles('<abc@d>')).toBe('abc@d')
    expect(stripAngles('  ')).toBeUndefined()
    expect(stripAngles(undefined)).toBeUndefined()
  })

  it('parses references', () => {
    expect(parseReferences('<a@x> <b@x>')).toEqual(['a@x', 'b@x'])
    expect(parseReferences(undefined)).toEqual([])
  })

  it('maps IMAP flags', () => {
    expect(parseFlags(new Set(['\\Seen', '$Forwarded']))).toEqual({
      seen: true,
      flagged: false,
      answered: false,
      draft: false,
      forwarded: true
    })
  })

  it('parses folded header blocks', () => {
    const headers = parseHeaderBlock('References: <a@x>\r\n <b@x>\r\nSubject: hi\r\n')
    expect(headers.references).toBe('<a@x> <b@x>')
    expect(headers.subject).toBe('hi')
  })

  it('makes windows safe filenames', () => {
    expect(safeFilename('in/voice:2025?.pdf')).toBe('in_voice_2025_.pdf')
    expect(safeFilename('')).toBe('attachment')
  })

  it('converts html to text', () => {
    expect(htmlToText('<p>Hello<br>World</p><style>.a{}</style>')).toBe('Hello\nWorld')
  })
})

describe('snippets', () => {
  it('collapses whitespace and trims to ~160 chars', () => {
    const long = `word `.repeat(200)
    const snippet = makeSnippet({ text: long })
    expect(snippet.length).toBeLessThanOrEqual(161)
    expect(snippet).not.toMatch(/ {2}/)
  })

  it('falls back to html', () => {
    expect(makeSnippet({ html: '<p>Hello&nbsp;&amp; welcome</p>' })).toBe('Hello & welcome')
  })
})

describe('body structure', () => {
  it('flattens parts and classifies inline vs attachment', () => {
    const parts = flattenStructure(MIXED_STRUCTURE)
    expect(parts.map((p) => p.partId)).toEqual(['1', '2', '3'])
    expect(parts[1]?.isInline).toBe(true)
    expect(parts[1]?.isAttachment).toBe(false)
    expect(parts[2]?.isAttachment).toBe(true)
  })

  it('does not count inline images as attachments', () => {
    const inlineOnly: ImapBodyStructure = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', size: 10 },
        { part: '2', type: 'image/png', id: '<sig@x>', disposition: 'inline', size: 10 }
      ]
    }
    expect(hasAttachments(inlineOnly)).toBe(false)
    expect(hasAttachments(MIXED_STRUCTURE)).toBe(true)
    expect(hasAttachments({ type: 'text/plain', size: 10 })).toBe(false)
  })
})

describe('toMessageUpsert', () => {
  it('maps an envelope fetch', () => {
    const row = toMessageUpsert(
      { accountId: 'acc1', folderId: 'fold1' },
      {
        uid: 42,
        flags: new Set(['\\Seen', '\\Flagged']),
        size: 1234,
        internalDate: new Date('2025-09-02T10:11:00Z'),
        envelope: {
          date: new Date('2025-09-02T10:11:12Z'),
          subject: 'Weekly digest',
          messageId: '<plain-1@example.com>',
          inReplyTo: '<parent-1@example.com>',
          from: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
          to: [{ address: 'jamie@unimail.test' }],
          cc: [],
          bcc: []
        },
        bodyStructure: MIXED_STRUCTURE,
        headers: Buffer.from('References: <root-1@example.com> <parent-1@example.com>\r\n'),
        threadId: '17322',
        emailId: '9911'
      }
    )
    expect(row.uid).toBe(42)
    expect(row.subject).toBe('Weekly digest')
    expect(row.messageIdHeader).toBe('plain-1@example.com')
    expect(row.inReplyTo).toBe('parent-1@example.com')
    expect(row.references).toEqual(['root-1@example.com', 'parent-1@example.com'])
    expect(row.from[0]).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' })
    expect(row.flags.seen).toBe(true)
    expect(row.flags.flagged).toBe(true)
    expect(row.hasAttachments).toBe(true)
    expect(row.gmThrid).toBe('17322')
    expect(row.gmMsgid).toBe('9911')
    expect(row.date).toBe(new Date('2025-09-02T10:11:12Z').getTime())
  })

  it('falls back to internalDate when the Date header is missing', () => {
    const internal = new Date('2025-01-01T00:00:00Z')
    const row = toMessageUpsert({ accountId: 'a', folderId: 'f' }, { uid: 1, internalDate: internal, envelope: { subject: 'x' } })
    expect(row.date).toBe(internal.getTime())
    expect(row.internalDate).toBe(internal.getTime())
    expect(row.hasAttachments).toBe(false)
    expect(row.size).toBe(0)
  })
})

describe('parseMessageSource', () => {
  it('parses a plain text message', async () => {
    const body = await parseMessageSource(PLAIN_MESSAGE)
    expect(body.text).toContain('plain text message')
    expect(body.html).toBeUndefined()
    expect(body.headers['list-unsubscribe']).toContain('https://example.com/unsub')
    expect(body.headers['message-id']).toBe('<plain-1@example.com>')
    expect(body.references).toEqual(['root-1@example.com', 'parent-1@example.com'])
    expect(body.inReplyTo).toBe('parent-1@example.com')
    expect(body.attachments).toHaveLength(0)
    expect(body.hasAttachments).toBe(false)
    expect(body.snippet.startsWith('Hello there,')).toBe(true)
    expect(body.snippet).not.toContain('quoted line')
  })

  it('parses a multipart message and keeps real IMAP part ids', async () => {
    const body = await parseMessageSource(MIXED_MESSAGE, MIXED_STRUCTURE)
    expect(body.html).toContain('<b>Jamie</b>')
    expect(body.text).toContain('Jamie')
    expect(body.attachments).toHaveLength(2)

    const logo = body.attachments.find((a) => a.filename === 'logo.png')
    const invoice = body.attachments.find((a) => a.filename === 'invoice.pdf')
    expect(logo?.contentId).toBe('logo123')
    expect(logo?.isInline).toBe(true)
    expect(logo?.partId).toBe('2')
    expect(invoice?.isInline).toBe(false)
    expect(invoice?.partId).toBe('3')
    expect(invoice?.contentType).toBe('application/pdf')
    expect(body.hasAttachments).toBe(true)
  })
})
