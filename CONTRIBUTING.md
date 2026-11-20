# Contributing to K2 Companion

K2 Companion is the phone client for a K2 agent server: a Tauri 2 app with a
React front end and a small amount of native code for iOS and Android.

## Getting started

```sh
npm ci
npm run dev          # the web front end in a browser
npx tsc --noEmit     # type check
npx vitest run       # tests
```

Mobile builds need the Tauri 2 mobile toolchain (Xcode for iOS, Android
Studio and the NDK for Android). See the Tauri docs for setup.

## Where things are

- `src/` — the React app (`src/zen/` is the current UI, `src/api/` the
  server client, `src/lib/` small helpers).
- `src/kit/mobileChat/` — the reusable chat kit (keyboard, composer, send
  motion). Its guide is `docs/mobile-chat-kit.md`; new chat screens should
  use it rather than reimplement it.
- `src-tauri/` — the Tauri shell and the native plugin (`tauri-plugin-k2-push`).
- `scripts/` — release and tooling scripts.

## Pull requests

- Keep changes focused, with tests for behaviour you change.
- Use neutral example names in tests, fixtures and docs (`example.k2.dev`,
  `alice`, `bob`), never real people, servers or machines.
- Don't commit secrets, local paths or workspace files (`.k2/` is ignored).

## Licence

MIT; see `LICENSE`.
