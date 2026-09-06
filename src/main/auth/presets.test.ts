import { describe, expect, it } from 'vitest'
import { PRESETS, domainOf, presetById, presetForEmail } from './presets'

describe('presets', () => {
  it('covers every ProviderId exactly once', () => {
    const ids = PRESETS.map((p) => p.id)
    expect(ids).toEqual(['gmail', 'outlook', 'spacemail', 'icloud', 'yahoo', 'fastmail', 'imap'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses implicit TLS or STARTTLS ports consistently', () => {
    for (const p of PRESETS) {
      if (!p.imap.host) continue
      expect(p.imap.secure ? [993] : [143]).toContain(p.imap.port)
      expect(p.smtp.secure ? [465] : [587]).toContain(p.smtp.port)
    }
  })

  it('marks Outlook as OAuth-only (Microsoft killed basic auth)', () => {
    const outlook = presetById('outlook')!
    expect(outlook.authTypes).toEqual(['oauth2'])
    expect(outlook.oauthProvider).toBe('microsoft')
    expect(outlook.imap).toEqual({ host: 'outlook.office365.com', port: 993, secure: true })
    expect(outlook.smtp).toEqual({ host: 'smtp.office365.com', port: 587, secure: false })
  })

  it('offers both OAuth and app passwords for Gmail', () => {
    const gmail = presetById('gmail')!
    expect(gmail.authTypes).toEqual(['oauth2', 'password'])
    expect(gmail.oauthProvider).toBe('google')
    expect(gmail.helpUrl).toBe('https://myaccount.google.com/apppasswords')
    expect(gmail.help).toMatch(/2-Step Verification/)
  })

  it('has the verified Spacemail servers and no fixed domains', () => {
    const sm = presetById('spacemail')!
    expect(sm.imap).toEqual({ host: 'mail.spacemail.com', port: 993, secure: true })
    expect(sm.smtp).toEqual({ host: 'mail.spacemail.com', port: 465, secure: true })
    expect(sm.domains).toEqual([])
    expect(sm.authTypes).toEqual(['password'])
  })

  it('leaves the generic IMAP preset blank', () => {
    const generic = presetById('imap')!
    expect(generic.imap.host).toBe('')
    expect(generic.smtp.host).toBe('')
    expect(generic.domains).toEqual([])
  })
})

describe('domainOf', () => {
  it.each([
    ['Jamie@Example.COM', 'example.com'],
    ['  jamie@example.com  ', 'example.com'],
    ['weird+tag@sub.example.co.uk', 'sub.example.co.uk'],
    ['a@b@example.com', 'example.com'],
    ['jamie@example.com.', 'example.com']
  ])('parses %s', (input, expected) => {
    expect(domainOf(input)).toBe(expected)
  })

  it.each(['', 'nope', '@example.com', 'jamie@', 'jamie@localhost', 'jamie@ex ample.com'])(
    'rejects %s',
    (input) => {
      expect(domainOf(input)).toBeUndefined()
    }
  )
})

describe('presetForEmail', () => {
  it.each([
    ['jamie@gmail.com', 'gmail'],
    ['jamie@googlemail.com', 'gmail'],
    ['JAMIE@GMAIL.COM', 'gmail'],
    ['jamie@outlook.com', 'outlook'],
    ['jamie@hotmail.com', 'outlook'],
    ['jamie@live.com', 'outlook'],
    ['jamie@msn.com', 'outlook'],
    ['jamie@icloud.com', 'icloud'],
    ['jamie@me.com', 'icloud'],
    ['jamie@mac.com', 'icloud'],
    ['jamie@yahoo.com', 'yahoo'],
    ['jamie@yahoo.co.uk', 'yahoo'],
    ['jamie@yahoo.fr', 'yahoo'],
    ['jamie@ymail.com', 'yahoo'],
    ['jamie@fastmail.com', 'fastmail']
  ])('%s -> %s', (email, id) => {
    expect(presetForEmail(email)?.id).toBe(id)
  })

  it('matches yahoo country domains not in the explicit list', () => {
    expect(presetForEmail('jamie@yahoo.com.sg')?.id).toBe('yahoo')
    expect(presetForEmail('jamie@yahoo.gr')?.id).toBe('yahoo')
  })

  it('does not match near-misses', () => {
    expect(presetForEmail('jamie@notyahoo.com')).toBeUndefined()
    expect(presetForEmail('jamie@gmail.com.evil.net')).toBeUndefined()
    expect(presetForEmail('jamie@yahoo-mail.com')).toBeUndefined()
  })

  it('returns undefined (not the generic preset) for unknown domains', () => {
    expect(presetForEmail('jamie@capspace.io')).toBeUndefined()
    expect(presetForEmail('not-an-email')).toBeUndefined()
  })
})
