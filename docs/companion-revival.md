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

## Open questions / Rosson-only

- Does the daemon still serve any `/companion/*` routes, or is everything `/cli/*` now?
  (Iteration 2: diff the companion's expected endpoints vs the daemon's actual routes.)
- Tunnel credentials / a K2 Connect subdomain for this machine (Phase 5 e2e).
- iOS device signing identity for an on-device build (Phase 5).

## Progress log

- **Iter 1**: Phase 1 rebrand complete — K2 icons generated, identity → "K2 Companion"
  / `dev.k2.companion`, branding strings updated, frontend typecheck clean. Committed.
  Next: Phase 2 transport — map companion's API surface against the daemon's real routes.
