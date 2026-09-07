# Getting started with Estuary

From download to a working unified inbox. Ten minutes if you use app passwords, twenty if you
set up OAuth as well.

## 1. Install

Download **[Estuary-Setup.exe](https://github.com/TheJamieFarrell/estuary/releases/latest/download/Estuary-Setup.exe)**
and run it.

The build is not code-signed, so Windows SmartScreen will probably say *"Windows protected your
PC"*. Click **More info**, then **Run anyway**. If you would rather not take that on trust, the
whole source is in this repository and `npm run dist` produces the same installer.

Estuary installs per-user into `%LOCALAPPDATA%\Programs\Estuary` and puts a shortcut on your
Desktop and in the Start menu. No administrator rights are needed, at install or at update time.

## 2. Add your first account

Open Estuary and click **Add account** at the bottom of the sidebar (or
**Settings → Accounts → Add account**), then type your email address.

Estuary recognises the common providers and fills in the servers. For a domain it does not know,
it looks the settings up in Thunderbird's autoconfig database and in your DNS records, and if
that fails it lets you type the host, port and TLS mode in by hand.

**Test connection** checks IMAP and SMTP separately, so you find out which half is wrong before
anything is saved.

### Which password?

| Provider | What to enter |
| --- | --- |
| **Gmail** | A 16-character [app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification on first), *or* sign in with Google — see step 3. Your normal password is rejected. |
| **Outlook / Microsoft 365** | Nothing here. Microsoft has turned off password authentication for IMAP and SMTP, so this account **must** use OAuth — see step 3. |
| **Spacemail (Spaceship)** | The **mailbox** password you set in Spaceship under Mailboxes, not your Spaceship account password. |
| **iCloud** | An [app-specific password](https://account.apple.com) from Sign-In and Security. |
| **Yahoo** | An [app password](https://login.yahoo.com/account/security/app-passwords). |
| **Fastmail** | An app password from Settings → Privacy & Security → Connected apps. |
| **Anything else** | Your normal IMAP password, unless the provider requires an app password. |

## 3. If you want Gmail or Outlook over OAuth

Estuary does not ship with OAuth credentials of its own, so Google and Microsoft need a free
client that you register under your own account and paste into
**Settings → Accounts → OAuth clients**. It is a one-off, about ten minutes per provider.

**[OAUTH-SETUP.md](OAUTH-SETUP.md)** walks through every screen of both consoles. Two things from
it worth knowing before you start:

- **Google:** publish your app on the Audience page. Left in *Testing*, Google expires its refresh
  tokens after seven days and Estuary will ask you to sign in again every week.
- **Microsoft:** register the redirect URI as exactly `http://localhost`, under the
  *Mobile and desktop applications* platform, and set **Allow public client flows** to Yes.

Once the client ID is saved, **Add account → Gmail / Outlook → Sign in** opens your system
browser, you approve, and the account appears.

## 4. Add the rest

Repeat for every mailbox. They all merge into the **Inbox** at the top of the sidebar, ordered by
date, and each account also keeps its own folder tree below.

## 5. Worth doing once

- **Settings → Appearance:** light/dark/system theme (also the sun/moon button in the title bar)
  and a compact density option.
- **Settings → Behaviour:** close-to-tray and start-on-login. Closing the window hides Estuary to
  the tray by default; turn that off if you would rather it quit.
- **Settings → Privacy:** remote images are blocked until you allow them. Allow them per message
  from the reader, or globally here if you trust your own mail.
- **Settings → Notifications:** how loud new mail is, including quiet during a new account's
  first sync.

Estuary keeps roughly the newest 5,000 messages per account in the local cache and backfills
older ones in the background, so search gets better the longer you leave it running.

## Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous conversation |
| `Enter` | Open |
| `e` | Archive |
| `#` or `Del` | Delete |
| `r` / `a` / `f` | Reply / reply all / forward |
| `s` | Star · `u` unread · `I` read · `x` select |
| `c` or `Ctrl+N` | New message |
| `/` | Search |
| `g` then `i` / `s` / `t` / `d` | Go to Inbox / Starred / Sent / Drafts |
| `F5` or `Ctrl+R` | Sync now |
| `Ctrl+,` | Settings |
| `?` | Show all shortcuts |
| `Ctrl+Q` | Quit (rather than hide to tray) |

## When something goes wrong

- **A provider keeps rejecting the password** — it almost certainly wants an app password. Check
  the table above.
- **Gmail asks you to sign in every week** — your Google app is still in *Testing*. Publish it.
- **"Sign in again" out of nowhere** — refresh tokens are revoked by password changes, by removing
  the app in your Google or Microsoft account settings, and by six months of disuse. Use
  **Reconnect** on the account.
- **Logs** are at `%APPDATA%\Estuary\logs\main.log`. Redact addresses and message contents before
  pasting them into an issue.
- **Full reset:** quit Estuary and delete `%APPDATA%\Estuary`. Nothing on the server is touched.

The [troubleshooting section of OAUTH-SETUP.md](OAUTH-SETUP.md#troubleshooting) covers the
provider-side error codes in detail.
