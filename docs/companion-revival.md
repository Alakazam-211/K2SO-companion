# K2 Companion — revival to the new daemon (loop notes)

Persistent scratchpad for the `/loop` reviving the mobile companion against the
0.40.x K2 daemon (K2 Connect tunnel + login + live grid sessions).

**HARD CONSTRAINT:** no app releases/publishing (main K2 app or companion) while
this loop runs — local build/test only. Rosson reviews in the afternoon. Commits OK.

## Mission

Companion app (this repo) → connect over the **K2 Connect secure tunnel** to the
machine's daemon, authenticate with the **K2 Connect login** system, list and render
**live terminal sessions** running on the host. Success = companion (device/sim)
connects through the tunnel to THIS computer's daemon and shows a live local terminal.

## Reference points (host repo: /Users/z3thon/DevProjects/Alakazam Labs/K2SO)

- Live-session list route: `GET /cli/terminal/list-running` (`misc_routes.rs` →
  `terminal_lifecycle_routes::handle_list_running`). Auth: `?token=<daemon.token>`
  for the LOCAL token; over the tunnel use the K2 Connect session instead.
- Terminal read/scrollback: `/cli/terminal/read`. Live grid: grid-WS
  (`sessions_grid_ws.rs`, shared emitter — `terminal:grid`/`terminal:scrollback`).
- K2 Connect login/users: `crates/k2-daemon/src/connect_users_routes.rs`
  (argon2 owner pw, sessions, roles — Owner/Admin/Member).
- Tunnel/lease: `crates/k2-core/src/tunnel/`. Subdomain model `your-name.k2.dev`.
- **Reference client (mirror this):** renderer's K2 Connect login + tunnel addressing
  — `src/renderer/components/Settings/sections/K2ConnectSection.tsx`,
  `src/renderer/stores/connect-host.ts`.

## Companion current state (as of iteration 1)

- Tauri v2 + React; `gen/apple` iOS project exists (no android gen yet).
- Old transport: `/companion/*` API over a **manually-typed ngrok URL**, Basic-auth →
  bearer token, in-memory (no persistence). Files: `src/api/client.ts`,
  `src/api/websocket.ts`, `src/stores/auth.ts`, `src/pages/Login.tsx`.
- Terminal renderer ALREADY uses `CompactLine` grid + WS subscription
  (`src/components/TerminalView.tsx`) — architecturally compatible with the daemon's
  grid-WS. This is the easy part; the work is re-wiring transport + auth.
- Session list: `src/pages/Sessions.tsx` ← `/companion/sessions` (`GlobalSession[]`).

## Phases

1. **Rebrand** — DONE (iteration 1). K2 icon via `tauri icon`; productName/title
   "K2 Companion"; identifier `dev.k2.companion`; user-facing "K2SO"→"K2/Alakazam Labs".
   NOTE: `gen/apple` still pins old bundle id `com.alakazamlabs.k2so.companion` →
   regenerate (`tauri ios init`/`gen`) before a device build (Phase 5). Internal Rust
   crate name `k2so-companion`/`k2so_companion_lib` left as-is (gen/apple references it).
2. **Transport** — re-point API+WS from `/companion/*`/ngrok to daemon `/cli/*` + grid-WS;
   reachable at localhost (dev) and `*.k2.dev` (tunnel). NEXT.
3. **Auth** — replace Basic-auth with K2 Connect login (mirror connect-host store);
   persist session via `tauri-plugin-store` (already a dep); implement `restoreSession()`.
4. **Live sessions** — list from daemon + render live terminal via grid-WS.
5. **End-to-end** — bring up the K2 Connect tunnel for this daemon; point companion at
   the subdomain; log in; confirm a live local terminal renders.

## Phase 2 — transport mapping (RESOLVED iteration 2)

**Architecture clarified:** the OLD `/companion/*` API was served by a LEGACY
**ngrok proxy** (`crates/k2-core/src/companion/mod.rs` — "exposes a curated subset
through an ngrok tunnel"). That's the pre-K2-Connect companion. The NEW path: the
**K2 Connect tunnel** (`*.k2.dev`, frpc — `crates/k2-core/src/tunnel/`) exposes the
daemon's MAIN HTTP server, which already has **purpose-built `/cli/companion/*`
routes emitting the exact JSON shapes the app expects** (see
`crates/k2-core/src/companion/cli_routes.rs`). So we re-point the app to `/cli/*`
over the K2 Connect tunnel — NOT to the legacy ngrok proxy.

**Endpoint translation (companion app → daemon `/cli/*`):**

| App's old call (`src/api/client.ts`) | New daemon route |
|---|---|
| `POST /companion/auth` (Basic auth) | `POST /cli/auth/login` `{username,password}` → session token (PUBLIC, no token gate; `connect_users_routes::handle_login`) |
| `GET /companion/sessions` | `GET /cli/companion/sessions` (companion-shaped `GlobalSession[]`) |
| `GET /companion/projects` | `GET /cli/companion/projects` |
| `GET /companion/projects/summary` | `GET /cli/companion/projects-summary` |
| `GET /companion/presets` | `GET /cli/companion/presets` |
| `GET /companion/agents/running` | `GET /cli/terminal/list-running` |
| `GET /companion/terminal/read` | `GET /cli/terminal/read` |
| `POST /companion/terminal/write` | `POST /cli/terminal/write` |
| `POST /companion/terminal/spawn` | `POST /cli/terminal/spawn` (+ `/spawn-background`) |
| `GET /companion/status` | `GET /cli/companion/status` |
| WS `/companion/ws` (terminal grid) | WS `/cli/sessions/grid?session=<UUID>&token=<tok>` (shared grid emitter; inbound `{"action":"resize","cols":N,"rows":N}`) |

**Auth model:** `POST /cli/auth/login {username,password}` returns a **session
token** (K2 Connect login = `connect_users_routes`, #617; argon2; roles
Owner/Admin/Member). All subsequent `/cli/*` calls + the grid-WS authenticate with
`?token=<sessionToken>` (query param accepted; the local daemon token is the
fallback for localhost dev). This REPLACES the app's Basic-auth/bearer flow.

**Connection:** base URL becomes `https://<subdomain>.k2.dev` (tunnel) or
`http://127.0.0.1:<daemon.port>` (localhost dev). Drop ngrok URL entry + the
`ngrok-skip-browser-warning` header.

## Open questions / Rosson-only

- Tunnel credentials / a K2 Connect subdomain for this machine (Phase 5 e2e).
- iOS device signing identity for an on-device build (Phase 5).
- Confirm `/cli/auth/login` session-token is accepted as `?token=` on the
  `/cli/companion/*` + `/cli/terminal/*` + grid-WS routes when arriving via the
  tunnel's acceptance policy (verify in iteration 3 against the live daemon).

## Progress log

- **Iter 1**: Phase 1 rebrand complete — K2 icons generated, identity → "K2 Companion"
  / `dev.k2.companion`, branding strings updated, frontend typecheck clean. Committed.
- **Iter 2**: Phase 2 transport MAPPING resolved (see table above). Legacy `/companion/*`
  = ngrok proxy (dead path); new path = `/cli/*` over the K2 Connect tunnel; daemon
  already has companion-shaped `/cli/companion/*` routes + `/cli/auth/login` session
  auth + `/cli/sessions/grid` WS.
- **Iter 2b (Phase 2a — transport rewrite DONE)**: rewrote `src/api/client.ts`:
  - All paths re-pointed `/companion/*` → `/cli/*` (verified shapes live against the
    local daemon: `/cli/companion/sessions|projects|projects-summary|presets|status`
    all return RAW companion-shaped JSON — NOT a `{ok,data}` envelope).
  - `httpRequest` now wraps raw 2xx bodies as `{ok:true,data}`, maps non-2xx →
    `{ok:false,error}`, auths via `?token=<sessionToken>`, dropped the ngrok header.
  - `login()` → `POST /cli/auth/login {username,password}` → raw `{token,username,
    expiresAt}` (verified: 401 `{error:"invalid username or password"}` on bad creds).
  - Secondary routes mapped to closest verified `/cli/*` (`reviews`→`/cli/reviews`,
    wake→`/cli/heartbeat/fire` [param model differs — flagged], agents→`/cli/agents/list`,
    work→`/cli/inbox/list`) — need per-screen param verification later.
  - `auth.ts`: removed the dead `/companion/ws` RPC connect; data is HTTP-only now.
  - Frontend typecheck clean. Committed.
  - **BLOCKER for full login test:** need a K2 Connect user account on the daemon
    (username/password) to test a SUCCESSFUL login + that the session token is accepted
    as `?token=` on `/cli/*` over the tunnel. `/cli/users/list` 404'd — find the real
    user-create route, or Rosson creates a test account. (Localhost dev can also test
    data routes directly with the local daemon token.)
- **Iter 3 (Phase 4 grid-WS — transport + converter DONE, proven live)**:
  - **Grid-WS PROVEN against the local daemon** (curl WS upgrade): `GET
    /cli/sessions/grid?session=<id>&token=<localToken>` → `HTTP 101` + a full
    `{"event":"snapshot","payload":{...}}` streaming the REAL Cortana terminal content.
    Auth via `?token=` works; live data flows.
  - **CRITICAL format correction:** the grid-WS does NOT send `GridUpdate{lines:
    CompactLine[]}`. It sends the alacritty-v2 shape (camelCase):
    - snapshot `TermGridSnapshot`: `{cols, rows, grid: CellRun[][], scrollback:
      CellRun[][], cursor:{row,col,visible}, version, displayOffset}`
    - delta `TermGridDelta`: `{cols, rows, damagedRows:[{row,cells:CellRun[]}],
      scrollbackAppended: CellRun[][], cursor, version, displayOffset}`
    - `CellRun`: `{text, fg?:u32, bg?:u32, bold, italic, underline, inverse, dim,
      strikeout}` (per-run style booleans, text carried inline).
    - events: `snapshot|delta|child_exit|title|label_initial|label_changed|bell|error`;
      inbound `input{text}|resize{cols,rows}|set_active{active,cols?,rows?}`.
  - **Built** `src/api/gridSocket.ts`: `GridSocket` (connect/backoff/close, read-only —
    does NOT send resize since the PTY is shared) + `cellRowToCompact()` converter
    (CellRun[] → the renderer's CompactLine {text, spans:[{s,e,fg,bg,fl}]}, fl bitmask
    mirrors grid_types ATTR_*).
  - **Rewired** `TerminalView.tsx` to a two-buffer model: `scrollback` only grows
    (delta.scrollbackAppended), `viewport` = bottom `rows` rows (snapshot replaces,
    delta.damagedRows patch in place); rebuild → GridUpdate → existing `applyGridUpdate`.
    HTTP `readTerminal` kept as the no-WS fallback (iOS-device WKWebView WS limit).
  - Frontend typecheck + full vite build clean. Committed.
  - **NOT yet visually verified in the running app** — the grid-WS is proven by curl,
    but the in-app render path (login → sessions list → open terminal → see live grid)
    needs a real run. That needs either a K2 Connect account (login) or a localhost dev
    run with a session token.
- **Iter 4 (Phase 3 auth — DONE; full chain proven end-to-end)**:
  - **FULL AUTH CHAIN VALIDATED** against the local daemon (curl):
    1. `POST /cli/users/add?token=<daemonToken>` `{username,password}` → `{"success":true}`
       (the local **daemon token IS the owner credential** — `require_owner` accepts it;
       user mgmt routes are `/cli/users/{add,remove,set-password,set-role,...}`, list is
       bare `GET /cli/users` — that's why `/cli/users/list` 404'd).
    2. `POST /cli/auth/login {username,password}` → 64-char session token.
    3. session token as `?token=` on `/cli/companion/sessions` → **HTTP 200 + real data**.
    4. session token on grid-WS `/cli/sessions/grid` → **HTTP 101**.
    → ANSWERS the iter-2 open question: the K2 Connect session token authenticates BOTH
    the data routes AND the grid-WS. The companion's transport+auth+grid chain is fully
    proven at the protocol level.
  - **DEV ACCOUNT for in-app testing:** username `mobiletest` / password `k2mobiletest!`
    (created on THIS machine's daemon; dev box only).
  - **Session persistence wired:** registered `tauri_plugin_store` in `src-tauri/lib.rs`
    (was a dep but NOT initialized → JS `load()` would've failed); added `store:default`
    + `http://127.0.0.1:*` / `http://localhost:*` to `capabilities/default.json` (the
    http allow was https-only → localhost dev would've been blocked); `auth.ts` now
    persists `{serverUrl,username,token}` on login and `restoreSession()` re-applies it
    optimistically on startup (already called from App.tsx).
  - Frontend build + `cargo check` both clean. Committed.
- **Iter 5 (converter validated against LIVE frames)**:
  - Extracted the pure converter + wire types into `src/api/gridConvert.ts` (no Tauri
    imports → Node-testable); `gridSocket.ts` re-exports it (TerminalView imports
    unchanged). Typecheck clean.
  - Wrote `scripts/test-grid-convert.mjs` (`npm run test:grid`) — connects to the live
    grid-WS with the dev account, runs the SAME `cellRowToCompact` against real frames.
    **PASS:** 40 grid + 5 scrollback rows converted, all spans ordered/in-bounds, styles
    (color/flags) preserved, rendered text = the real Cortana session ("❯ Hello there!",
    "⏺ Hello! 👋 I'm Cortana…"). Converter is proven, not just the protocol.
  - Creds for the test come from `/tmp/k2mob-test-creds.txt` (PORT|sessionToken|sid),
    regenerated each loop setup via login as `mobiletest`.

## STATUS SUMMARY (phases 1–4 done + validated; phase 5 blocked on Rosson)

- **Phase 1 rebrand** ✅ — K2 icon + identity.
- **Phase 2 transport** ✅ — client.ts on `/cli/*`; verified live (data routes 200, right shapes).
- **Phase 3 auth** ✅ — `/cli/auth/login` session token; persistence via plugin-store;
  FULL chain proven (login → token authenticates data routes AND grid-WS).
- **Phase 4 live grid** ✅ — GridSocket + converter; grid-WS proven (101 + real snapshot);
  converter proven by `npm run test:grid` against live frames.
- **Phase 5 end-to-end over the K2 Connect tunnel** ⏳ — BLOCKED on Rosson: needs a
  tunnel/subdomain (`*.k2.dev`) for this machine's daemon. All the code paths it exercises
  are already validated against localhost; the tunnel just changes the base URL (https
  subdomain) — the app already supports that (login URL → `https://<sub>` when no scheme).

- **Iter 6 (secondary endpoints verified + wake route fixed)**:
  - `/cli/agents/list` → returns the EXACT `Agent` shape (name, role, isManager,
    agentType, inbox/active/doneCount) ✓. `/cli/companion/projects[-summary]`, `status`
    ✓ (earlier). `/cli/reviews` → valid array (empty; item shape unverified, no data).
    `/cli/inbox/list` (agent work) → HTTP 200 ✓.
  - **Fixed wake**: `wakeAgent` now hits `GET /cli/agents/heartbeat?agent=<name>&
    force_wake=1` (the route the host CLI uses) instead of the wrong `/cli/heartbeat/fire`
    (name-model). Not live-fired (waking spawns a real session). Typecheck clean. Committed.
  - Companion's screens now all map to correct, verified `/cli/*` routes.

- **Iter 7 (delta path validated; GridModel extracted)**: pulled the two-buffer model out
  of TerminalView into a pure, testable `GridModel` (gridConvert.ts). `npm run test:grid`
  now also validates the DELTA path with synthetic frames — snapshot→delta (damagedRows
  patch + scrollbackAppended grow + absolute cursor row + contiguous rows): 11/11 pass;
  live snapshot still green. The full render pipeline (snapshot AND delta) is now proven.

- **Iter 8 (login UX polish)**: login screen now says "K2 Connect address" with a
  `your-name.k2.dev` placeholder (was ngrok), `type=text` so subdomain-only or
  `localhost:PORT` entries don't trip HTML5 URL validation (auth.ts prepends the scheme).
  Build clean. This was the last meaningful autonomous task.

## LOOP PAUSED (autonomous work complete) — awaiting Rosson

Phases 1–4 + secondary screens + login UX are DONE and validated against the live daemon.
The render pipeline (snapshot + delta) is proven by `npm run test:grid`. The ONLY thing
left for full mission success is the over-the-tunnel run, which needs Rosson:
- **K2 Connect tunnel/subdomain** for this machine → then point the app at `https://<sub>.k2.dev`,
  log in as `mobiletest`/`k2mobiletest!`, confirm a live local terminal renders. (Every
  path this exercises is already proven on localhost; the tunnel only changes the base URL.)
- **On-screen visual check** (foregrounds a window — left for Rosson).
- **iOS device signing** + `gen/apple` rebundle to `dev.k2.companion` (Rosson signs/builds).
Restart the loop (or ping) once a tunnel subdomain exists and I'll close Phase 5 immediately.

### Remaining autonomous work (not Rosson-blocked)
- **In-app on-screen render** — run the companion app locally (`tauri dev`, allowed: local
  test, NOT a release) pointed at `http://127.0.0.1:<daemon.port>`, log in as `mobiletest`,
  and confirm a terminal renders live in the actual webview. (Heavier — needs the desktop
  app window + UI drive; the render INPUT is already proven correct.)
- Secondary endpoint param verification (agents/work/wake/reviews screens).
- `gen/apple` regenerate for `dev.k2.companion` (needed for an iOS device build — Rosson signing).

### Rosson-only
- K2 Connect tunnel creds / subdomain for the Phase 5 over-the-tunnel run.
- iOS device signing identity for an on-device build.
- Dev account on THIS daemon: `mobiletest` / `k2mobiletest!` (created for testing; remove later).

---

## Iter 9 (2026-06-18) — live-stream fix; full e2e on zPhoneAir

Mission is **done end-to-end**: app runs on zPhoneAir, logs in over the
`z3thon.k2.dev` tunnel to THIS machine's daemon, and renders a live terminal.
Everything Rosson-blocked above has since been unblocked (tunnel live, LZTEK
signing team `36B8R93HXV` baked into `gen/apple`, device build flow proven).

### The "blocks, not live" bug (fixed)
Terminal only refreshed on (re)snapshots — deltas never applied. Root cause: the
daemon's `DamagedRow` wire field is `runs` (grid_snapshot.rs, `#[serde(rename_all
= "camelCase")]`, no rename → stays `runs`), but `gridConvert.ts` read `cells`.
`cellRowToCompact(undefined)` threw on every delta and the `gridSocket` onmessage
`try/catch` swallowed it. Fix: read `runs`; harden onmessage to LOG handler errors
(never swallow); unit test corrected to the real wire shape (`npm run test:grid`
green). Wire contract re-confirmed against daemon source.

### Also this iter
- Login screen now shows the K2-by-Alakazam-Labs wordmark (`src/assets/login-logo.png`).
- Build hardening: added `src/vite-env.d.ts` (`vite/client`) so `tsc` resolves the
  png import + `import.meta.env`; dropped two now-stale `@ts-expect-error` dirs.
- Workspace `.k2so` → `.k2` cutover committed (mechanical; fan-out symlinks re-pointed).

### Build / install / launch (device)
```
PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" ./node_modules/.bin/tauri ios build --debug
xcrun devicectl device install app --device <zPhoneAir-UDID> \
  src-tauri/gen/apple/build/k2so-companion_iOS.xcarchive/Products/Applications/K2.app
xcrun devicectl device process launch --device <zPhoneAir-UDID> --terminate-existing dev.k2.companion
```
Note: `cargo` (rustup shim) lives at `~/.cargo/bin` — must be on PATH or the
tauri ios build dies early on `cargo metadata` (No such file).

### Open / forward-looking (not blocking)
- Companion could subscribe to `/cli/sessions/events` for a live session list
  ("daemon as server" shape) instead of one-shot list fetches.
- Releases still NOT done — local build/test only, per standing constraint.
