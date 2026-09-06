/**
 * Connection test for the account wizard: IMAP login + capabilities, SMTP verify,
 * with error messages a human can act on.
 */
import { ImapFlow } from 'imapflow'
import log from 'electron-log/main'
import type { AccountInput, ConnectionTestResult } from '@shared/types'
import type { AuthService } from '../contracts'
import { buildImapOptions, errorMessage, resolveAuthForInput, withTimeout } from './connection'
import { createTransport, describeSmtpError } from './smtp'

const testLog = log.scope('imap')

const TEST_TIMEOUT_MS = 15_000

/** Translate IMAP failures into advice. */
export function describeImapError(err: unknown, input: Pick<AccountInput, 'imap' | 'authType' | 'provider'>): string {
  const message = errorMessage(err)
  if (/Application-specific password required/i.test(message)) {
    return 'Google needs an app password for this account (2-Step Verification is on), or connect it with Google sign-in instead.'
  }
  if (/basic authentication is disabled|AUTHENTICATE failed|LOGIN failed|authenticate failed/i.test(message) && input.authType === 'password') {
    const microsoft = /outlook|office365|hotmail/i.test(input.imap.host) || input.provider === 'outlook'
    return microsoft
      ? 'Microsoft has disabled password logins for IMAP - connect this account with Microsoft sign-in (OAuth).'
      : `The server rejected the login: ${message}`
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|invalid login|authentication fail/i.test(message)) {
    return 'The server rejected the username or password.'
  }
  if (/invalid_grant|token/i.test(message)) return 'The saved authorisation expired - sign in again.'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return `Could not find the server "${input.imap.host}" - check the host name.`
  if (/ECONNREFUSED/i.test(message)) return `The server refused the connection on port ${input.imap.port}.`
  if (/ETIMEDOUT|timed? ?out|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return 'The server did not answer - check the host, the port and your connection.'
  }
  if (/certificate|self.signed|SSL|TLS|wrong version number/i.test(message)) {
    return `TLS problem: ${message}. Check the "use SSL/TLS" setting for port ${input.imap.port}.`
  }
  return message
}

export async function testConnection(input: AccountInput, auth: AuthService): Promise<ConnectionTestResult> {
  const result: ConnectionTestResult = { ok: false, imap: { ok: false }, smtp: { ok: false } }

  let credentials
  try {
    credentials = await resolveAuthForInput(input, auth)
  } catch (err) {
    const message = errorMessage(err)
    result.imap.error = message
    result.smtp.error = message
    return result
  }

  // ---- IMAP ---------------------------------------------------------------
  const client = new ImapFlow(buildImapOptions(input.imap, credentials, 'worker'))
  client.on('error', () => {
    /* handled by the awaited promises below */
  })
  try {
    await withTimeout(client.connect(), TEST_TIMEOUT_MS, `Connecting to ${input.imap.host}`)
    const caps = (client as unknown as { capabilities?: Map<string, unknown> }).capabilities
    result.imap = { ok: true, capabilities: caps ? Array.from(caps.keys()).map((k) => String(k)) : [] }
  } catch (err) {
    testLog.warn(`IMAP test failed for ${input.email}: ${errorMessage(err)}`)
    result.imap = { ok: false, error: describeImapError(err, input) }
  } finally {
    try {
      await withTimeout(client.logout(), 5_000, 'Logout')
    } catch {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
  }

  // ---- SMTP ---------------------------------------------------------------
  const transporter = createTransport(input, credentials)
  try {
    await withTimeout(transporter.verify(), TEST_TIMEOUT_MS, `Connecting to ${input.smtp.host}`)
    result.smtp = { ok: true }
  } catch (err) {
    testLog.warn(`SMTP test failed for ${input.email}: ${errorMessage(err)}`)
    result.smtp = { ok: false, error: describeSmtpError(err) }
  } finally {
    try {
      transporter.close()
    } catch {
      /* ignore */
    }
  }

  result.ok = result.imap.ok && result.smtp.ok
  return result
}
