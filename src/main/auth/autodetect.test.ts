import { describe, expect, it, vi } from 'vitest'
import {
  autodetect,
  expandPlaceholders,
  parseAutoconfig,
  providerFromMx,
  type AutodetectDeps
} from './autodetect'

// A trimmed-down but structurally faithful ISPDB document. Note the deliberately
// out-of-order servers: the plain/STARTTLS entries come first so the parser has to
// actually rank socket types rather than take the first match.
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <domain>example.net</domain>
    <displayName>Example Mail</displayName>
    <displayShortName>Example</displayShortName>
    <incomingServer type="pop3">
      <hostname>pop.example.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
      <addThisServer>true</addThisServer>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

describe('parseAutoconfig', () => {
  it('extracts the best IMAP and SMTP servers from an ISPDB document', () => {
    const parsed = parseAutoconfig(SAMPLE_XML, 'jamie@example.com')
    expect(parsed).not.toBeNull()
    expect(parsed!.provider).toBe('example.com')
    expect(parsed!.imap).toEqual({
      hostname: 'imap.example.com',
      port: 993,
      socketType: 'SSL',
      username: 'jamie@example.com'
    })
    expect(parsed!.smtp).toEqual({
      hostname: 'smtp.example.com',
      port: 587,
      socketType: 'STARTTLS',
      username: 'jamie@example.com'
    })
  })

  it('ignores pop3 incoming servers', () => {
    const parsed = parseAutoconfig(SAMPLE_XML, 'jamie@example.com')
    expect(parsed!.imap!.hostname).not.toContain('pop')
  })

  it('falls back to STARTTLS when there is no SSL entry', () => {
    const xml = SAMPLE_XML.replace(
      /<incomingServer type="imap">\s*<hostname>imap\.example\.com<\/hostname>\s*<port>993<\/port>[\s\S]*?<\/incomingServer>/,
      ''
    )
    const parsed = parseAutoconfig(xml, 'jamie@example.com')
    expect(parsed!.imap).toMatchObject({ port: 143, socketType: 'STARTTLS' })
  })

  it('expands hostname placeholders', () => {
    const xml = `<clientConfig><emailProvider id="p"><incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
      </incomingServer></emailProvider></clientConfig>`
    const parsed = parseAutoconfig(xml, 'jamie@capspace.io')
    expect(parsed!.imap!.hostname).toBe('imap.capspace.io')
  })

  it('returns null for junk, HTML error pages and empty input', () => {
    expect(parseAutoconfig('')).toBeNull()
    expect(parseAutoconfig('<html><body>404 Not Found</body></html>')).toBeNull()
    expect(parseAutoconfig('{"not":"xml"}')).toBeNull()
    expect(parseAutoconfig('<clientConfig><emailProvider id="x"/></clientConfig>')).toBeNull()
  })

  it('ignores servers with an unparseable port', () => {
    const xml = `<clientConfig><emailProvider id="p"><incomingServer type="imap">
      <hostname>imap.x.com</hostname><port>nope</port><socketType>SSL</socketType>
      </incomingServer></emailProvider></clientConfig>`
    expect(parseAutoconfig(xml)).toBeNull()
  })
})

describe('expandPlaceholders', () => {
  it('handles all three placeholders case-insensitively', () => {
    expect(expandPlaceholders('%emailaddress%|%EMAILLOCALPART%|%EmailDomain%', 'jamie@ex.com')).toBe(
      'jamie@ex.com|jamie|ex.com'
    )
  })
})

describe('providerFromMx', () => {
  it.each([
    [['aspmx.l.google.com', 'alt1.aspmx.l.google.com'], 'gmail', 'imap.gmail.com'],
    [['ASPMX.L.GOOGLE.COM.'], 'gmail', 'imap.gmail.com'],
    [['capspace-io.mail.protection.outlook.com'], 'outlook', 'outlook.office365.com'],
    [['mx1.spacemail.com', 'mx2.spacemail.com'], 'spacemail', 'mail.spacemail.com'],
    [['in1-smtp.messagingengine.com'], 'fastmail', 'imap.fastmail.com']
  ])('%s -> %s', (exchanges, provider, imapHost) => {
    const hit = providerFromMx(exchanges as string[])
    expect(hit?.provider).toBe(provider)
    expect(hit?.imap?.host).toBe(imapHost)
  })

  it('returns null for an unrecognised mail host', () => {
    expect(providerFromMx(['mx.zoho.eu'])).toBeNull()
    expect(providerFromMx([])).toBeNull()
  })
})

/** Deps that fail every network step, so a test only has to enable the one it cares about. */
function offlineDeps(over: AutodetectDeps = {}): AutodetectDeps {
  return {
    fetchText: async () => null,
    resolveSrv: async () => {
      throw new Error('ENOTFOUND')
    },
    resolveMx: async () => {
      throw new Error('ENOTFOUND')
    },
    probeTls: async () => false,
    probeTcp: async () => false,
    ...over
  }
}

describe('autodetect', () => {
  it('short-circuits on a known preset without touching the network', async () => {
    const fetchText = vi.fn(async () => null)
    const resolveMx = vi.fn(async () => [])
    const res = await autodetect('jamie@gmail.com', offlineDeps({ fetchText, resolveMx }))
    expect(res).toEqual({
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      provider: 'gmail'
    })
    expect(fetchText).not.toHaveBeenCalled()
    expect(resolveMx).not.toHaveBeenCalled()
  })

  it('uses the ISPDB before anything else for an unknown domain', async () => {
    const urls: string[] = []
    const res = await autodetect(
      'jamie@example.com',
      offlineDeps({
        fetchText: async (url) => {
          urls.push(url)
          return url.includes('autoconfig.thunderbird.net') ? SAMPLE_XML : null
        }
      })
    )
    expect(urls[0]).toBe('https://autoconfig.thunderbird.net/v1.1/example.com')
    expect(res).toEqual({
      imap: { host: 'imap.example.com', port: 993, secure: true },
      smtp: { host: 'smtp.example.com', port: 587, secure: false },
      provider: 'example.com'
    })
  })

  it('falls back to the provider-hosted autoconfig URLs', async () => {
    const urls: string[] = []
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        fetchText: async (url) => {
          urls.push(url)
          return url.startsWith('https://autoconfig.capspace.io/') ? SAMPLE_XML : null
        }
      })
    )
    expect(urls).toEqual([
      'https://autoconfig.thunderbird.net/v1.1/capspace.io',
      'https://autoconfig.capspace.io/mail/config-v1.1.xml?emailaddress=jamie%40capspace.io'
    ])
    expect(res?.imap?.host).toBe('imap.example.com')
  })

  it('reads RFC 6186 SRV records, preferring the implicit-TLS services', async () => {
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        resolveSrv: async (name) => {
          if (name === '_imaps._tcp.capspace.io') {
            return [{ name: 'imap.capspace.io', port: 993, priority: 10, weight: 1 }]
          }
          if (name === '_submissions._tcp.capspace.io') {
            return [{ name: 'smtp.capspace.io', port: 465, priority: 10, weight: 1 }]
          }
          throw new Error('ENODATA')
        }
      })
    )
    expect(res).toEqual({
      imap: { host: 'imap.capspace.io', port: 993, secure: true },
      smtp: { host: 'smtp.capspace.io', port: 465, secure: true },
      provider: 'srv'
    })
  })

  it('treats an SRV target of "." as "service not offered"', async () => {
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        resolveSrv: async (name) =>
          name === '_imaps._tcp.capspace.io'
            ? [{ name: '.', port: 0, priority: 0, weight: 0 }]
            : Promise.reject(new Error('ENODATA'))
      })
    )
    expect(res).toBeNull()
  })

  it('detects Google Workspace from the MX records', async () => {
    const resolveMx = vi.fn(async (domain: string) => {
      expect(domain).toBe('capspace.io')
      return [
        { exchange: 'ASPMX.L.GOOGLE.COM', priority: 1 },
        { exchange: 'alt1.aspmx.l.google.com', priority: 5 }
      ]
    })
    const res = await autodetect('jamie@capspace.io', offlineDeps({ resolveMx }))
    expect(resolveMx).toHaveBeenCalledOnce()
    expect(res).toEqual({
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      provider: 'gmail'
    })
  })

  it('detects Microsoft 365 from the MX records', async () => {
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        resolveMx: async () => [
          { exchange: 'capspace-io.mail.protection.outlook.com', priority: 0 }
        ]
      })
    )
    expect(res).toEqual({
      imap: { host: 'outlook.office365.com', port: 993, secure: true },
      smtp: { host: 'smtp.office365.com', port: 587, secure: false },
      provider: 'outlook'
    })
  })

  it('detects Spacemail from the MX records', async () => {
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        resolveMx: async () => [
          { exchange: 'mx1.spacemail.com', priority: 10 },
          { exchange: 'mx2.spacemail.com', priority: 10 }
        ]
      })
    )
    expect(res).toEqual({
      imap: { host: 'mail.spacemail.com', port: 993, secure: true },
      smtp: { host: 'mail.spacemail.com', port: 465, secure: true },
      provider: 'spacemail'
    })
  })

  it('only returns guessed hosts that actually answer TLS', async () => {
    const probed: string[] = []
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        probeTls: async (host, port) => {
          probed.push(`${host}:${port}`)
          return host === 'mail.capspace.io'
        }
      })
    )
    expect(probed).toContain('imap.capspace.io:993')
    expect(res).toEqual({
      imap: { host: 'mail.capspace.io', port: 993, secure: true },
      smtp: { host: 'mail.capspace.io', port: 465, secure: true },
      provider: 'guess'
    })
  })

  it('falls back to a plain 587 probe when 465 is closed', async () => {
    const res = await autodetect(
      'jamie@capspace.io',
      offlineDeps({
        probeTls: async (host, port) => port === 993 && host === 'imap.capspace.io',
        probeTcp: async (host, port) => port === 587 && host === 'smtp.capspace.io'
      })
    )
    expect(res?.smtp).toEqual({ host: 'smtp.capspace.io', port: 587, secure: false })
  })

  it('returns null when every step fails, and never throws', async () => {
    await expect(autodetect('jamie@capspace.io', offlineDeps())).resolves.toBeNull()
    await expect(
      autodetect(
        'jamie@capspace.io',
        offlineDeps({
          fetchText: async () => {
            throw new Error('boom')
          },
          probeTls: async () => {
            throw new Error('boom')
          }
        })
      )
    ).resolves.toBeNull()
  })

  it('returns null for anything that is not an email address', async () => {
    for (const bad of ['', 'nope', 'jamie@', '@example.com']) {
      await expect(autodetect(bad, offlineDeps())).resolves.toBeNull()
    }
  })
})
