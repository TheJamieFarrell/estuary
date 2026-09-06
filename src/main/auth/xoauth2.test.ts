import { describe, expect, it } from 'vitest'
import { oauthBearer, xoauth2 } from './xoauth2'

const SEP = String.fromCharCode(1)

describe('xoauth2', () => {
  it('matches the vector published in Google\'s XOAUTH2 documentation', () => {
    const encoded = xoauth2(
      'someuser@example.com',
      'ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg=='
    )
    expect(encoded).toBe(
      'dXNlcj1zb21ldXNlckBleGFtcGxlLmNvbQFhdXRoPUJlYXJlciB5YTI5LnZGOWRmdDRxbVRjMk52YjNSbGNrQmhkSFJoZG1semRHRXVZMjl0Q2c9PQEB'
    )
  })

  it('round-trips to the documented plaintext layout', () => {
    const decoded = Buffer.from(xoauth2('a@b.com', 'TOKEN'), 'base64').toString('utf8')
    expect(decoded).toBe(`user=a@b.com${SEP}auth=Bearer TOKEN${SEP}${SEP}`)
  })

  it('uses 0x01 as the separator, not a literal backslash-x-0-1', () => {
    const decoded = Buffer.from(xoauth2('a@b.com', 'T'), 'base64').toString('utf8')
    expect(decoded).not.toContain('\\')
    expect(decoded.charCodeAt('user=a@b.com'.length)).toBe(1)
  })

  it('builds an RFC 7628 OAUTHBEARER response', () => {
    const decoded = Buffer.from(
      oauthBearer('a@b.com', 'TOKEN', 'outlook.office365.com', 993),
      'base64'
    ).toString('utf8')
    expect(decoded).toBe(
      `n,a=a@b.com,${SEP}host=outlook.office365.com${SEP}port=993${SEP}auth=Bearer TOKEN${SEP}${SEP}`
    )
  })
})
