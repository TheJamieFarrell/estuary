# UniMail

One desktop inbox for Gmail, Outlook / Microsoft 365, Spacemail (Spaceship) and any other
IMAP/SMTP account. Electron + React + TypeScript, local-first: everything you see is served
from a local SQLite cache, so the UI stays fast and works offline.

## Requirements

- Windows 10/11 (the build targets Windows; the code itself is cross-platform)
- Node.js 20 or newer

## Running it

```bash
npm install          # native modules (better-sqlite3) are rebuilt for Electron automatically
npm run dev          # electron-vite dev server + Electron, with hot reload for the UI
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-safe production bundle into `out/` |
| `npm run dist` | Build + NSIS installer into `release/UniMail-Setup-<version>.exe` |
| `npm run dist:dir` | Build + unpacked app into `release/win-unpacked/` (fast, no installer) |
| `npm run typecheck` | `tsc` over main/preload and renderer |
| `npm test` | vitest (pure-logic tests only) |
| `node scripts/gen-icons.mjs` | Regenerate `resources/icon.png` and the tray icons |
| `powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` | Put a `UniMail.lnk` on the Desktop pointing at the installed or unpacked build |

## Adding accounts

Open **Settings -> Accounts -> Add account** and enter your email address. UniMail picks the
right server settings from its provider presets, then falls back to Thunderbird's autoconfig
database and DNS SRV records if it does not recognise the domain.

- **Gmail** and **Outlook / Microsoft 365** sign in with OAuth. Your browser opens, you approve,
  and the tokens come back to a one-shot loopback listener on `127.0.0.1`. This needs an OAuth
  client id, entered once — see **[docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md)**.
- **Spacemail, iCloud, Yahoo, Fastmail and generic IMAP** use a password. For providers with
  2FA (iCloud, Yahoo, Fastmail) that must be an **app password**, not your normal one; the
  account wizard links to the right page for each.
- **Test connection** in the wizard checks IMAP and SMTP separately before anything is saved.

Passwords and refresh tokens are encrypted with Electron's `safeStorage` (DPAPI on Windows) and
stored as blobs in the database. They are never sent to the renderer process.

## Where your data lives

Everything sits under `%APPDATA%\UniMail`:

```
%APPDATA%\UniMail\
  unimail.db          messages, folders, threads, drafts, settings, encrypted secrets
  attachments\        downloaded attachment cache, one folder per account
  logs\main.log       electron-log output
  window-state.json   remembered window size and position
```

Removing an account deletes its messages and its attachment folder. To reset the app
completely, quit it and delete the whole `%APPDATA%\UniMail` directory.

## Behaviour worth knowing

- **Close to tray.** Closing the window hides it to the tray by default; the tray icon shows an
  unread badge and quitting for real is *Quit UniMail* in its menu (or Ctrl+Q). Turn it off in
  Settings if you would rather the app exit on close.
- **Start on login.** Settings -> General, or the tray menu. The auto-started copy launches with
  `--hidden` and goes straight to the tray.
- **`mailto:` links.** Installed builds register as a `mailto:` handler; clicking one opens a
  compose window (and reuses the running instance).
- **Remote images** are blocked until you allow them, per message or globally in Settings.
  HTML mail is sanitised and rendered in a sandboxed iframe under a strict CSP.
- **Notifications** stay quiet during a newly-added account's first sync, then show up to three
  per batch, with a summary beyond that.

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and the sync/threading
design. The short version:

```
src/shared/     types.ts + ipc.ts - the contract between main and renderer
src/main/       app shell (windows, tray, menu, IPC), db/, mail/, auth/
src/preload/    contextBridge -> window.api
src/renderer/   React UI (inbox, reader, search, compose, settings)
```

## Licence

MIT.
