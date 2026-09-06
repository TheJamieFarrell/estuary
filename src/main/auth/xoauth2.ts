/**
 * SASL XOAUTH2 initial client response.
 *
 * Gmail and Outlook/Microsoft 365 both accept OAuth bearer tokens over IMAP and SMTP
 * through the XOAUTH2 SASL mechanism. The initial client response is:
 *
 *   base64("user=" + userName + ^A + "auth=Bearer " + accessToken + ^A + ^A)
 *
 * where ^A is the single control byte 0x01 (SOH).
 *
 * imapflow takes credentials as `auth: { user, accessToken }` and builds this itself,
 * but nodemailer's custom auth and any raw `AUTHENTICATE XOAUTH2 <blob>` command need
 * the encoded blob, so it lives here.
 */

/** SOH / ^A - the XOAUTH2 field separator. Built from a char code so no raw control
 *  byte or escape sequence ends up in the source file. */
const SEP = String.fromCharCode(1)

export function xoauth2(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}${SEP}auth=Bearer ${accessToken}${SEP}${SEP}`, 'utf8').toString(
    'base64'
  )
}

/**
 * SASL OAUTHBEARER (RFC 7628) initial client response. Some servers prefer this over
 * XOAUTH2; kept here so the mail engine has the option without reimplementing encoding.
 */
export function oauthBearer(user: string, accessToken: string, host: string, port: number): string {
  const payload = `n,a=${user},${SEP}host=${host}${SEP}port=${port}${SEP}auth=Bearer ${accessToken}${SEP}${SEP}`
  return Buffer.from(payload, 'utf8').toString('base64')
}
