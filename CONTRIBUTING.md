# Contributing to Estuary

Thanks for taking a look. Estuary is a small project, so the process is light: open an issue if
you want to talk something through first, otherwise send a pull request.

## Running it

You need **Node.js 20 or newer** and Windows for the packaged build (the code itself is
cross-platform, but only the Windows target is wired up).

```bash
npm install     # native modules are rebuilt for Electron automatically
npm run dev     # electron-vite dev server + Electron, hot reload for the UI
```

For UI-only work you can skip Electron entirely. `src/renderer/lib/api.ts` falls back to the
seeded in-memory mock in `src/renderer/lib/mock.ts` whenever `window.api` is missing, so the
renderer runs in a plain browser with three accounts and around 120 realistic threads:

```bash
npx vite --config vite.mock.config.ts --port 5179
# http://localhost:5179/index.html    main window
# http://localhost:5179/compose.html  compose window
```

## Before you open a PR

```bash
npm run typecheck   # tsc over main/preload and renderer — must be clean
npm test            # vitest
```

Both need to pass. If you changed anything in `src/main`, also run `npm run dist:dir` once and
launch `release/win-unpacked/Estuary.exe` — a lot of main-process behaviour (tray, notifications,
`mailto:` handling, updates) only shows up in a packaged build.

## Conventions

These come from [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); read it before a larger change.

- ESM TypeScript, `strict`. Two-space indent, **no semicolons**, single quotes — match the file
  you are editing.
- `src/shared/types.ts` and `src/shared/ipc.ts` are the **contract** between main and renderer.
  Changing them touches both sides; do it deliberately.
- Every main-process module exports a factory: `createMailStore()`,
  `createMailEngine(store, auth, paths)`, `createAuthService(store)`.
- ids are `crypto.randomUUID()` strings; timestamps are epoch-millisecond numbers.
- Log with `electron-log` (`import log from 'electron-log/main'`), scoped — `log.scope('imap')`.
- Errors thrown across IPC must be plain `Error`s with a message a user can read.
- Tests are vitest, colocated as `*.test.ts`, and cover **pure logic only** — threading, parsing,
  provider presets, search-query parsing. Do not add tests that need a live IMAP server.
- Secrets never reach the renderer. Passwords and refresh tokens are encrypted with `safeStorage`
  and stay in the main process.

## Pull requests

- One change per PR, with a short description of the problem it solves.
- Say how you tested it — especially for sync, threading or provider-specific behaviour, where
  the interesting cases are the ones a type-checker cannot see.
- UI changes: a before/after screenshot in both themes is very welcome.
- Do not commit anything from `config/*.local.json`, `release/`, or `out/` — they are gitignored
  for a reason, and the first can contain your own OAuth client IDs.

## Reporting bugs

Include your Windows version, the Estuary version (Settings → About), which provider the account
uses, and the relevant part of `%APPDATA%\Estuary\logs\main.log`. **Redact addresses, tokens and
message contents** before pasting a log — it records account addresses and folder names.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence, the same as
the rest of the project.
