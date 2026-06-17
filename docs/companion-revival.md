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
  auth + `/cli/sessions/grid` WS. Next (iter 3): rewrite `src/api/client.ts` endpoint
  constants + `src/api/websocket.ts` (grid-WS at `/cli/sessions/grid`), then verify
  each route live against the local daemon with a session token.
