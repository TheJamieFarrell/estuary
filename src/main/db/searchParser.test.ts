import { describe, expect, it } from 'vitest'
import { escapeFtsToken, parseDateToken, parseSearchQuery } from './searchParser'

describe('escapeFtsToken', () => {
  it('quotes tokens and doubles embedded quotes', () => {
    expect(escapeFtsToken('hello')).toBe('"hello"')
    expect(escapeFtsToken('say "hi"')).toBe('"say ""hi"""')
    expect(escapeFtsToken('a OR b*')).toBe('"a OR b*"')
  })
})

describe('parseDateToken', () => {
  it('parses YYYY-MM-DD at local midnight', () => {
    expect(parseDateToken('2026-09-06')).toBe(new Date(2026, 8, 6).getTime())
    expect(parseDateToken('2026/9/6')).toBe(new Date(2026, 8, 6).getTime())
    expect(parseDateToken('nonsense')).toBeUndefined()
    expect(parseDateToken('2026-13-01')).toBeUndefined()
  })
})

describe('parseSearchQuery', () => {
  it('returns an empty match for an empty query', () => {
    const p = parseSearchQuery('')
    expect(p.fts).toBe('')
    expect(p.where).toEqual([])
    expect(p.params).toEqual([])
  })

  it('prefix-matches the last free text token only', () => {
    const p = parseSearchQuery('quarterly report')
    expect(p.fts).toBe('"quarterly" AND "report"*')
    expect(p.terms.text).toEqual(['quarterly', 'report'])
  })

  it('keeps quoted phrases exact', () => {
    const p = parseSearchQuery('"exact phrase"')
    expect(p.fts).toBe('"exact phrase"')
    expect(p.terms.phrases).toEqual(['exact phrase'])
  })

  it('maps from:/to:/subject: onto FTS columns', () => {
    const p = parseSearchQuery('from:alice to:bob subject:"budget 2026"')
    expect(p.fts).toBe('sender : "alice"* AND recipients : "bob"* AND subject : "budget 2026"')
    expect(p.terms.from).toEqual(['alice'])
    expect(p.terms.to).toEqual(['bob'])
    expect(p.terms.subject).toEqual(['budget 2026'])
  })

  it('turns flag operators into SQL fragments', () => {
    const p = parseSearchQuery('has:attachment is:unread is:starred')
    expect(p.where).toEqual(['m.has_attachments = 1', 'm.seen = 0', 'm.flagged = 1'])
    expect(p.params).toEqual([])
    expect(p.fts).toBe('')
    expect(p.terms.hasAttachment).toBe(true)
  })

  it('supports is:read', () => {
    expect(parseSearchQuery('is:read').where).toEqual(['m.seen = 1'])
  })

  it('turns dates into bounded SQL', () => {
    const p = parseSearchQuery('after:2026-01-01 before:2026-02-01')
    expect(p.where).toEqual(['m.date >= ?', 'm.date < ?'])
    expect(p.params).toEqual([new Date(2026, 0, 1).getTime(), new Date(2026, 1, 1).getTime()])
  })

  it('maps in: onto a folder kind and flags the folders join', () => {
    const p = parseSearchQuery('in:sent invoice')
    expect(p.where).toEqual(['fo.kind = ?'])
    expect(p.params).toEqual(['sent'])
    expect(p.needsFolders).toBe(true)
    expect(p.fts).toBe('"invoice"*')
  })

  it('treats an unknown in: value as a folder name/path', () => {
    const p = parseSearchQuery('in:Receipts')
    expect(p.where).toEqual(['(fo.name = ? COLLATE NOCASE OR fo.path = ? COLLATE NOCASE)'])
    expect(p.params).toEqual(['Receipts', 'Receipts'])
  })

  it('escapes hostile tokens instead of letting them reach FTS as syntax', () => {
    const p = parseSearchQuery('foo" OR bar')
    expect(p.fts).toBe('"foo""" AND "OR" AND "bar"*')
  })

  it('combines operators, phrases and text', () => {
    const p = parseSearchQuery('from:bob has:attachment "status update" invoice in:inbox')
    expect(p.fts).toBe('sender : "bob"* AND "status update" AND "invoice"*')
    expect(p.where).toEqual(['m.has_attachments = 1', 'fo.kind = ?'])
    expect(p.params).toEqual(['inbox'])
  })

  it('negates with a leading dash and never starts the match with NOT', () => {
    const p = parseSearchQuery('report -draft')
    expect(p.fts).toBe('"report"* AND NOT "draft"')
    expect(parseSearchQuery('-draft').fts).toBe('')
  })
})
