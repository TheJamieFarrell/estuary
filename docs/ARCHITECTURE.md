# Estuary architecture

Universal inbox desktop app for Windows. Electron 44 + electron-vite + React 19 + TypeScript.
Accounts: Gmail, Outlook/Microsoft 365, Spacemail (Spaceship), and any IMAP/SMTP server.

## Layout

```
src/shared/types.ts      domain types (CONTRACT - shared by main + renderer)
src/shared/ipc.ts        IPC channel + event map (CONTRACT)
src/main/contracts.ts    MailStore / MailEngine / AuthService interfaces (CONTRACT)
src/main/index.ts        app entry: paths, create services, windows, tray, IPC  [shell]
src/main/ipc.ts          ipcMain.handle for every IpcInvokeMap channel          [shell]
src/main/windows.ts      main window + compose windows                          [shell]
src/main/tray.ts, notifications.ts, loginItem.ts                                [shell]
src/main/db/             node:sqlite (DatabaseSync) store implementing MailStore            [db]
src/main/mail/           imapflow/nodemailer engine implementing MailEngine     [mail]
src/main/auth/           OAuth loopback flow, presets, autodetect               [auth]
src/preload/index.ts     contextBridge exposing window.api (RendererApi)        [shell]
src/renderer/index.html  main window  -> src/renderer/main.tsx
src/renderer/compose.html compose window -> src/renderer/compose.tsx
src/renderer/styles/     tokens.css (design tokens, both themes), global.css
src/renderer/lib/        api.ts (typed wrapper + browser mock), store.ts (zustand), utils
src/renderer/features/   inbox/ reader/ search/ nav/ compose/ settings/ accounts/
resources/               icon.ico, icon.png, tray icons
```

## Key decisions

- **IMAP everywhere.** Gmail and Outlook are accessed over IMAP/SMTP with XOAUTH2, Spacemail and
  others with passwords. One engine, provider quirks in `src/main/mail/providers.ts`.
- **OAuth is loopback.** System browser -> `http://127.0.0.1:<random port>/callback`. PKCE always.
  Google: "Desktop app" client (has a non-secret client secret). Microsoft: public client, no secret,
  tenant `common`, scopes `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email`.
  Google scopes `https://mail.google.com/ openid email`.
  Client ids are entered once in Settings and stored in AppSettings.oauthClients.
- **Secrets** (passwords, refresh tokens) are encrypted with `safeStorage.encryptString` and stored as blobs in SQLite. Never sent to the renderer.
- **Local-first.** SQLite is the source of truth for the UI. Actions apply locally at once, are queued in
  `pending_actions`, and replayed to the server. Sends go through `outbox`. Sync reconciles.
- **Threading.** Per account. Gmail: X-GM-THRID. Others: References / In-Reply-To chain, then
  normalised-subject + participant fallback within 7 days. Unified list = threads from all accounts merged by lastDate.
- **Sync.** Per account: LIST with SPECIAL-USE -> map folder kinds. INBOX gets IDLE. Initial sync fetches
  newest 200 envelopes per synced folder, then backfills in 200-UID chunks in the background until
  `cacheLimit` (default 5000). Bodies for the newest 50 inbox messages are prefetched; others on open.
  Flag reconciliation: CONDSTORE/QRESYNC when advertised, else periodic `FETCH 1:* (FLAGS)` for cached UIDs.
- **Archive semantics.** Gmail: remove from INBOX (message stays in All Mail) = MOVE to `[Gmail]/All Mail`.
  Outlook: MOVE to `Archive`. Others: MOVE to a folder of kind archive; create `Archive` if absent.
- **Trash semantics.** MOVE to trash folder. `deletePermanently` only inside Trash/Spam (flag \Deleted + EXPUNGE).
- **HTML mail** is sanitised with DOMPurify and rendered in a sandboxed `<iframe sandbox="allow-same-origin">`
  with a strict CSP. Remote images blocked unless the setting or a per-message "load images" is on. `cid:` images
  are resolved through `attachments:inlineDataUrl`.
- **Compose** runs in its own BrowserWindow (`compose.html`) so it can float beside the inbox. TipTap editor.
- **Notifications** via Electron `Notification`; clicking focuses the main window and navigates to the thread.
  Tray icon with unread badge; close-to-tray; `app.setLoginItemSettings` for start on login.
- **Renderer dev without Electron:** `src/renderer/lib/api.ts` falls back to an in-memory mock when
  `window.api` is undefined so UI work can run in a plain browser.

## Conventions

- ESM TypeScript, strict. 2-space indent, no semicolons (matching existing files), single quotes.
- ids are `crypto.randomUUID()` strings. Timestamps are epoch ms numbers.
- Every main module exports a factory: `createMailStore()`, `createMailEngine(store, auth, paths)`, `createAuthService(store)`.
- Log with `electron-log` (`import log from 'electron-log/main'`), scoped: `log.scope('imap')`.
- Errors thrown across IPC must be plain `Error` with a user-readable message.
- Tests: vitest, colocated `*.test.ts`, only for pure logic (threading, parsing, presets, search parsing).
