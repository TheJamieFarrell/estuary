# Connecting Gmail and Outlook to UniMail

UniMail talks to every mailbox over plain IMAP and SMTP. For most providers that means a
password (usually an *app password*). Google and Microsoft are different: they want the app to
sign you in through your browser using OAuth 2.0, and they require the app itself to be
registered in their developer console first.

Because UniMail is a personal app rather than a product with a published, Google-verified
identity, **you register the app once, under your own account**, and paste the resulting client
ID into UniMail's settings. It takes about ten minutes per provider and you never do it again.

- **Gmail** – OAuth is recommended, but there is a five-minute alternative: an **app password**.
  See [Gmail without any setup](#gmail-without-any-setup-app-passwords) at the end.
- **Outlook.com / Hotmail / Live / MSN** – **OAuth is the only option.** Microsoft has switched
  off basic (password) authentication for IMAP and SMTP on personal Microsoft accounts, and app
  passwords no longer work for mail. There is no way around Part B for these accounts.
- Everything else (Spacemail, iCloud, Yahoo, Fastmail, your own IMAP server) needs none of this.

## What UniMail does with what you paste in

UniMail runs the loopback flow from RFC 8252: it opens your **system browser**, listens on a
random port on `127.0.0.1`, and catches the authorization code when the provider redirects back.
PKCE (S256) is always used. There is no embedded browser and no password ever passes through
UniMail. Refresh tokens are encrypted with Windows DPAPI (Electron `safeStorage`) and stored in
the local SQLite database; they are never sent to the renderer process and never leave your PC
except back to Google or Microsoft.

### Redirect URIs

| Provider | What UniMail actually calls | What you register in the console |
| --- | --- | --- |
| Google | `http://127.0.0.1:<random port>/callback` | **Nothing.** A "Desktop app" client accepts any loopback address, port and path automatically. |
| Microsoft | `http://localhost:<random port>` | Exactly `http://localhost` — no port, no trailing slash, no path. |

Two things worth knowing about the Microsoft entry:

- Entra **ignores the port** on `localhost` redirect URIs, which is why a single
  `http://localhost` registration covers every random port UniMail picks.
- The Azure/Entra portal **refuses to accept `http://127.0.0.1`** in the redirect URI box (only
  `https` is allowed for non-localhost hosts). Type `localhost`, not the IP address. UniMail also
  listens on `[::1]` with the same port, so it does not matter which address your browser
  resolves `localhost` to.

---

## Part A — Google (Gmail)

You need a Google Cloud project, the Gmail API enabled on it, an OAuth consent screen, and a
"Desktop app" OAuth client. All of it is free.

### A1. Create a project

1. Open <https://console.cloud.google.com/projectcreate>.
2. **Project name**: `UniMail` (only you will ever see it). Leave the organisation as-is.
3. Click **Create**, then make sure the new project is selected in the picker at the top of the
   page before continuing.

### A2. Enable the Gmail API

1. Open <https://console.cloud.google.com/apis/library/gmail.googleapis.com>.
2. Check the project name at the top, then click **Enable**.

The `https://mail.google.com/` scope UniMail requests belongs to the Gmail API, so the API has to
be enabled on the project even though UniMail connects over IMAP rather than the REST API.

### A3. Configure the Google Auth Platform

The old "OAuth consent screen" page is now **Google Auth Platform**, split into Overview,
Branding, Audience, Data Access, Clients and Verification Center.

1. Open <https://console.cloud.google.com/auth/overview>.
2. Click **Get started** and fill in the short form:
   - **App name**: `UniMail`
   - **User support email**: your own address
   - **Audience**: choose **External**. (**Internal** only exists if you have Google Workspace,
     and if you pick it only accounts in your Workspace can sign in.)
   - **Contact information**: your own address
   - Agree to the user data policy and click **Create**.

### A4. Choose between "Testing" and "In production"

Open <https://console.cloud.google.com/auth/audience>. Your app starts in **Testing**. This
matters more than it looks:

| | Testing | In production (unverified) |
| --- | --- | --- |
| Who can sign in | Only addresses in the **Test users** list (max 100) | Anyone, up to the unverified-app user cap |
| Warning screen | Yes | Yes |
| **Refresh token lifetime** | **Expires after 7 days** | Does not expire |

Google expires refresh tokens issued by an app in *Testing* after seven days, so if you leave the
app in Testing **UniMail will ask you to sign in to Gmail again every week**. Pick one:

- **Recommended — publish it.** On the Audience page click **Publish app** and confirm. Because
  `https://mail.google.com/` is a *restricted* scope and your app is not verified, you will still
  see a "Google hasn't verified this app" screen when you sign in (see A6), but refresh tokens
  stop expiring. You do **not** need to submit anything for verification; verification only
  matters if you intend to distribute the app to other people.
- **Or accept the weekly re-login.** Stay in Testing and, under **Test users**, click **Add
  users**, enter every Gmail address you plan to add to UniMail, and **Save**. An address that is
  not on this list is refused with `access_denied`.

### A5. Create the OAuth client

1. Open <https://console.cloud.google.com/auth/clients>.
2. Click **Create client**.
3. **Application type**: **Desktop app**.
4. **Name**: `UniMail desktop`.
5. Click **Create**.

A dialog shows your **Client ID** and **Client secret**. Copy both now, or click **Download JSON**
— newer Google projects hide the secret after this dialog closes and only show its last four
characters afterwards. If you lose it you can always delete the client and create another.

> The "client secret" on a desktop client is not really a secret: Google's own documentation says
> desktop apps cannot keep it confidential, which is exactly why PKCE is mandatory. Paste it into
> UniMail anyway — Google's token endpoint still wants it — but do not treat it as a credential
> worth protecting.

### A6. Put it into UniMail

1. In UniMail open **Settings → Accounts → OAuth clients**.
2. Paste the **Client ID** and **Client secret** into the Google boxes and save.
3. **Add account → Gmail → Sign in with Google.**
4. Your browser opens. Choose your account. If the app is unverified you will see
   **"Google hasn't verified this app"** — click **Advanced**, then **Go to UniMail (unsafe)**.
   This warning is about *your own* app; the "unsafe" wording is Google's blanket text for any
   client it has not reviewed.
5. Approve the request to "Read, compose, send and permanently delete all your email from Gmail"
   (that is what `https://mail.google.com/` means — it is the IMAP/SMTP-equivalent scope; there is
   no narrower scope that permits IMAP).
6. The tab shows "You can return to UniMail". Close it; the account is added.

---

## Part B — Microsoft (Outlook.com, Hotmail, Live, MSN, Microsoft 365)

Microsoft calls this an *app registration*. Sign in with the same Microsoft account you want to
read mail for; a personal account gets a free directory the first time you visit.

### B1. Register the application

1. Open <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>
   (or in the Azure portal: <https://portal.azure.com> → search **App registrations**).
2. Click **+ New registration**.
3. **Name**: `UniMail`.
4. **Supported account types**: **Accounts in any organizational directory (Any Microsoft Entra
   ID tenant – Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**.
   This is the only option that lets both `@outlook.com` addresses and work/school accounts sign
   in, and it is what UniMail's `/common` endpoint expects.
5. **Redirect URI**: choose platform **Public client/native (mobile & desktop)** from the
   dropdown and enter exactly:

   ```
   http://localhost
   ```

6. Click **Register**.

### B2. Copy the Application (client) ID

On the **Overview** page, copy **Application (client) ID** — a GUID like
`11111111-2222-3333-4444-555555555555`. That is the only value UniMail needs.

**Do not create a client secret.** UniMail is a public client; a secret would be ignored, and
sending one from a desktop app is a liability, not a protection.

### B3. Confirm the platform and turn on public client flows

1. In the left menu click **Authentication**.
2. Under **Platform configurations** you should see **Mobile and desktop applications** with
   `http://localhost` listed. If the URI landed under a *Web* platform instead, delete it, click
   **+ Add a platform → Mobile and desktop applications**, and add `http://localhost` there. The
   platform type decides how Entra returns the code, so this matters.
3. Scroll to **Advanced settings → Allow public client flows** and set it to **Yes**.
4. Click **Save**.

### B4. API permissions

1. Click **API permissions → + Add a permission**.
2. Open the **APIs my organization uses** tab and search for **Office 365 Exchange Online**.
   - If it is not listed, search instead for its application ID
     `00000002-0000-0ff1-ce00-000000000000`.
   - If it still is not listed, **skip this whole step** — see the note below. A brand-new
     directory created for a personal Microsoft account often has no Exchange Online licence and
     therefore does not surface the API in the picker.
3. Choose **Delegated permissions** (*not* Application permissions — those are for unattended
   daemons and additionally require a tenant admin plus Exchange PowerShell).
4. Tick:
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`
5. Click **Add permissions**.
6. `offline_access`, `openid` and `email` are Microsoft Graph delegated permissions and are
   normally already present under **Microsoft Graph**. If they are not, add them the same way via
   **Microsoft Graph → Delegated permissions**.

> **Why this step is optional for personal accounts.** Microsoft's v2.0 endpoint uses *dynamic*
> consent: UniMail asks for
> `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send
> offline_access openid email` in the authorization request itself, and you approve exactly those
> at sign-in. The API permissions list mainly exists so that an administrator can pre-consent on
> behalf of a whole organisation. If you are connecting a work or school account whose tenant
> requires admin consent, this list is what your admin approves — and they may also need to make
> sure IMAP and authenticated SMTP are enabled for your mailbox in Exchange Online.

### B5. Put it into UniMail

1. **Settings → Accounts → OAuth clients**, paste the **Application (client) ID** into the
   Microsoft box (leave the secret field empty) and save.
2. **Add account → Outlook → Sign in with Microsoft.**
3. Approve the consent screen listing IMAP and SMTP access, then close the browser tab.

---

## Gmail without any setup: app passwords

If you would rather not create a Google Cloud project, Gmail still accepts a 16-character
**app password** over IMAP and SMTP.

1. Turn on **2-Step Verification** for your Google Account — app passwords do not exist without
   it: <https://myaccount.google.com/signinoptions/two-step-verification>
2. Go to <https://myaccount.google.com/apppasswords>, type a name such as `UniMail`, and click
   **Create**.
3. Copy the 16 characters (spaces do not matter) and paste them into UniMail's password field.
   In **Add account → Gmail** choose **Use an app password** instead of **Sign in with Google**.

Your normal Google password will be rejected; only the app password works. IMAP no longer needs
to be switched on manually in Gmail settings.

The equivalent for other providers:

| Provider | App password page |
| --- | --- |
| iCloud | <https://account.apple.com> → Sign-In and Security → App-Specific Passwords |
| Yahoo | <https://login.yahoo.com/account/security/app-passwords> |
| Fastmail | Settings → Privacy & Security → Connected apps & app passwords |
| Spacemail | No app password. Use the **mailbox** password set in Spaceship, not your Spaceship account password. |

**There is no app-password route for Outlook.com.** Microsoft removed basic auth for IMAP/SMTP on
personal accounts, so Part B is mandatory for those addresses.

---

## Troubleshooting

**`redirect_uri_mismatch` (Google)** — the OAuth client is not of type **Desktop app**. Web
application clients require every redirect URI to be pre-registered and reject loopback ports.
Delete the client and create a Desktop app one.

**`AADSTS50011: The reply URL specified in the request does not match…` (Microsoft)** — the
registration is missing `http://localhost`, or it was added under the *Web* platform instead of
*Mobile and desktop applications*. Fix it in **Authentication** (step B3).

**The portal will not let me type `http://127.0.0.1`** — correct, and expected. Use
`http://localhost`; UniMail handles the rest.

**`AADSTS7000218` / "client_assertion or client_secret required"** — **Allow public client flows**
is still **No**. Set it to Yes (step B3).

**`access_denied` on Google, "This app is blocked"** — your app is in *Testing* and the address is
not in the Test users list, or you clicked Cancel on the unverified-app warning.

**UniMail asks me to sign in to Gmail again every week** — your Google Auth Platform app is still
in *Testing*, which caps refresh tokens at 7 days. Publish the app (step A4).

**"Sign in again" out of nowhere** — a refresh token can also be revoked when you change your
password, remove the app at <https://myaccount.google.com/permissions> or
<https://account.live.com/consent/Manage>, or leave the account unused for six months. UniMail
flags the account and offers **Reconnect**, which reruns the same browser flow.

**Nothing happens when the browser should open** — UniMail hands the URL to your default browser
via the OS. If no default browser is set, the sign-in fails immediately with "Could not open the
system browser".

**The browser sign-in page never returns** — the loopback listener times out after 5 minutes. A
VPN or security product that intercepts `localhost` can break the redirect; disable it for the
sign-in, or use an app password for Gmail instead.

**Work or school account, everything configured, still rejected** — your tenant may have IMAP or
authenticated SMTP disabled per-mailbox, or require admin consent for the Exchange scopes. Both
are administrator settings in Exchange Online, not something UniMail can change.

## Reference

- Google Auth Platform overview — <https://support.google.com/cloud/answer/15544987>
- Google, OAuth 2.0 for native apps — <https://developers.google.com/identity/protocols/oauth2/native-app>
- Google app passwords — <https://support.google.com/accounts/answer/185833>
- Microsoft, OAuth for IMAP/POP/SMTP — <https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth>
- Microsoft, redirect URI rules and the localhost exception — <https://learn.microsoft.com/en-us/entra/identity-platform/reply-url>
- RFC 8252, OAuth 2.0 for Native Apps — <https://datatracker.ietf.org/doc/html/rfc8252>
