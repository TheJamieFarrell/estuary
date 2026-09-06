import { describe, expect, it } from 'vitest'
import {
  normaliseAddress,
  normaliseMessageId,
  normaliseSubject,
  parseReferences,
  pickMergeTarget,
  resolveThread,
  SUBJECT_THREAD_WINDOW_MS,
  type ThreadLookups
} from './threading'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)

function lookups(overrides: Partial<ThreadLookups> = {}): ThreadLookups {
  return {
    byGmThrid: () => undefined,
    byMessageIds: () => [],
    byReferencing: () => [],
    bySubject: () => [],
    ...overrides
  }
}

describe('normaliseSubject', () => {
  it('strips reply and forward prefixes in any language/order', () => {
    expect(normaliseSubject('Re: Hello')).toBe('hello')
    expect(normaliseSubject('RE: FWD: Re: Quarterly numbers')).toBe('quarterly numbers')
    expect(normaliseSubject('AW: Angebot')).toBe('angebot')
    expect(normaliseSubject('Re[2]: Ticket')).toBe('ticket')
    expect(normaliseSubject('SV: Fw: Møte')).toBe('møte')
  })

  it('collapses whitespace and lowercases', () => {
    expect(normaliseSubject('  Weekly   Report \n')).toBe('weekly report')
  })

  it('leaves list tags and empty subjects alone', () => {
    expect(normaliseSubject('[dev] Build broken')).toBe('[dev] build broken')
    expect(normaliseSubject(undefined)).toBe('')
    expect(normaliseSubject('Reply to this')).toBe('reply to this')
  })
})

describe('address + message id helpers', () => {
  it('normalises addresses and message ids', () => {
    expect(normaliseAddress('  Alice@Example.COM ')).toBe('alice@example.com')
    expect(normaliseMessageId('<abc@def>')).toBe('abc@def')
    expect(parseReferences('<a@x> <b@x>\n <a@x>')).toEqual(['a@x', 'b@x'])
    expect(parseReferences(['<c@x>'])).toEqual(['c@x'])
  })
})

describe('resolveThread', () => {
  const base = {
    accountId: 'acc1',
    subject: 'Re: Lunch',
    participants: ['alice@example.com', 'bob@example.com'],
    date: NOW
  }

  it('uses the Gmail thread id when present', () => {
    const r = resolveThread(
      { ...base, gmThrid: '17', messageIdHeader: 'new@x' },
      lookups({ byGmThrid: (t) => (t === '17' ? 'thread-gmail' : undefined) })
    )
    expect(r.reason).toBe('gmail')
    expect(r.threadIds).toEqual(['thread-gmail'])
  })

  it('starts a new thread for an unknown Gmail thread id without falling through', () => {
    const r = resolveThread(
      { ...base, gmThrid: '99' },
      lookups({ bySubject: () => [{ threadId: 'nope', participants: ['alice@example.com'], lastDate: NOW }] })
    )
    expect(r.reason).toBe('gmail')
    expect(r.threadIds).toEqual([])
  })

  it('follows the reference chain', () => {
    const seen: string[][] = []
    const r = resolveThread(
      { ...base, inReplyTo: '<root@x>', references: ['<root@x>'] },
      lookups({
        byMessageIds: (ids) => {
          seen.push(ids)
          return ids.includes('root@x') ? ['thread-root'] : []
        }
      })
    )
    expect(seen[0]).toEqual(['root@x'])
    expect(r.reason).toBe('references')
    expect(r.threadIds).toEqual(['thread-root'])
  })

  it('finds a thread that already references this message (out of order delivery)', () => {
    const r = resolveThread(
      { ...base, messageIdHeader: '<parent@x>' },
      lookups({ byReferencing: (id) => (id === 'parent@x' ? ['thread-child'] : []) })
    )
    expect(r.reason).toBe('references')
    expect(r.threadIds).toEqual(['thread-child'])
  })

  it('reports every linked thread so the caller can merge them', () => {
    const r = resolveThread(
      { ...base, references: ['<a@x>', '<b@x>'] },
      lookups({ byMessageIds: () => ['thread-a', 'thread-b', 'thread-a'] })
    )
    expect(r.threadIds).toEqual(['thread-a', 'thread-b'])
  })

  it('falls back to normalised subject + participant overlap within 7 days', () => {
    const r = resolveThread(
      base,
      lookups({
        bySubject: (subject, from, to) => {
          expect(subject).toBe('lunch')
          expect(from).toBe(NOW - SUBJECT_THREAD_WINDOW_MS)
          expect(to).toBe(NOW + SUBJECT_THREAD_WINDOW_MS)
          return [{ threadId: 'thread-subject', participants: ['BOB@example.com'], lastDate: NOW - 2 * DAY }]
        }
      })
    )
    expect(r.reason).toBe('subject')
    expect(r.threadIds).toEqual(['thread-subject'])
  })

  it('rejects a subject match with no shared participant', () => {
    const r = resolveThread(
      base,
      lookups({
        bySubject: () => [{ threadId: 'other', participants: ['carol@example.com'], lastDate: NOW - DAY }]
      })
    )
    expect(r.reason).toBe('new')
    expect(r.threadIds).toEqual([])
  })

  it('rejects a subject match outside the 7 day window', () => {
    const r = resolveThread(
      base,
      lookups({
        bySubject: () => [
          {
            threadId: 'old',
            participants: ['alice@example.com'],
            lastDate: NOW - 30 * DAY,
            firstDate: NOW - 40 * DAY
          }
        ]
      })
    )
    expect(r.reason).toBe('new')
  })

  it('does not thread on an empty subject', () => {
    const r = resolveThread({ ...base, subject: '' }, lookups({ bySubject: () => [{ threadId: 'x', participants: ['alice@example.com'], lastDate: NOW }] }))
    expect(r.reason).toBe('new')
  })

  it('ignores a self-reference', () => {
    const asked: string[][] = []
    resolveThread(
      { ...base, messageIdHeader: '<self@x>', references: ['<self@x>'] },
      lookups({
        byMessageIds: (ids) => {
          asked.push(ids)
          return []
        }
      })
    )
    expect(asked).toEqual([])
  })
})

describe('pickMergeTarget', () => {
  it('keeps the biggest thread', () => {
    expect(pickMergeTarget([{ id: 'a', messageCount: 2 }, { id: 'b', messageCount: 9 }])).toEqual({
      keep: 'b',
      merge: ['a']
    })
  })

  it('breaks ties on the oldest thread', () => {
    expect(
      pickMergeTarget([
        { id: 'a', messageCount: 3, firstDate: 500 },
        { id: 'b', messageCount: 3, firstDate: 100 }
      ])
    ).toEqual({ keep: 'b', merge: ['a'] })
  })
})
