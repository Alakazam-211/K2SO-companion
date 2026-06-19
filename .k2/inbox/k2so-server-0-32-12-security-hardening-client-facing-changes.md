---
title: K2SO server 0.32.12: security hardening — client-facing changes
priority: high
assigned_by: external
created: 2026-04-19
type: task
source: manual
---

K2SO server 0.32.12 shipped a companion-security hardening pass. Most of it is transparent, but a few things change behavior for this app.

## New surface

- **POST /companion/auth/revoke** (Bearer-authenticated). Call this on explicit user logout — purges the current session token server-side and kicks any WS clients bound to it. Idempotent. Returns 200.
- **WS method `auth.revoke`** (same semantics). Server will send a WS Close frame after the revoke response.
- **Tauri event `companion:tunnel_activated`** — fires when the tunnel comes up. Payload: `{ tunnelUrl, allowRemoteSpawn, corsOriginsCount }`. Not directly reachable from mobile, but the K2SO desktop app surfaces this in logs; mobile can observe its own first successful `/companion/auth` and treat that as the signal.

## Changed response shapes

- `/companion/auth` now returns **429** when per-IP rate limit exceeded. Body includes `retryAfterSeconds: <number>`. Thresholds: 5 attempts/minute, 20 attempts/hour, keyed by X-Forwarded-For. App should honor Retry-After + surface a clear \"too many attempts\" message rather than blind-retrying.
- All error responses now include `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. No action needed unless the app parses response headers; the bodies are unchanged.

## Breaking — privileged endpoints gated

- **POST /companion/terminal/spawn** returns **403** unless user has flipped a new Settings toggle (\"Allow Remote Spawn\"). Default: OFF. Same for:
  - POST /companion/terminal/spawn-background
  - WS terminal.spawn
  - WS terminal.spawn_background
- 403 body: `{ ok: false, error: \"Remote terminal spawn is disabled. Enable 'Allow remote spawn' in Companion settings and restart the tunnel to permit this endpoint.\" }`.
- **If the app currently relies on spawn to start a terminal for the user:** surface this 403 gracefully, direct the user to the setting, and retry after they restart the tunnel. The rationale is defense in depth — if a bearer token is stolen, arbitrary shell execution should require explicit operator opt-in.

## Breaking — CORS (browser clients only)

- `Access-Control-Allow-Origin` is no longer `*`. Only origins listed in the operator's `companion.corsOrigins` allowlist get reflected. Empty allowlist = no CORS headers.
- **Native iOS/Android app unaffected** — CORS isn't enforced by native HTTP clients.
- If there's ever a web/PWA variant of the companion, that origin must be added to the allowlist in K2SO desktop Settings.

## Session lifecycle

- **Changing the K2SO companion password invalidates every live session immediately.** Next request with a stale token returns 401. App should catch 401 → force re-auth via `/companion/auth`.
- Same on explicit logout (POST /companion/auth/revoke) and on K2SO settings reset.
- Tokens still expire after 24h as before.

## WebSocket Origin/Host

- WS upgrade requests are now gated on Origin + Host headers before the handshake. Policy:
  - Missing Origin → allowed (native clients don't set one — no change needed)
  - Origin matches tunnel URL → allowed
  - Host must match the tunnel hostname or be loopback
  - Anything else → plain HTTP 403 before the upgrade completes
- If the app uses a WebView for some portion of its flow and that WebView starts making WS requests to the tunnel, the Origin must be in `corsOrigins` or match the tunnel URL.

## Keychain migration (informational)

- The server now stores its password hash in the macOS Keychain instead of `settings.json`. Transparent to the mobile app — auth requests work identically. No action needed.

## Suggested app-side work

1. **Handle 403 from /companion/terminal/spawn** with a dedicated error state pointing the user to the Settings toggle. This is the one thing most likely to cause visible breakage if the app uses spawn.
2. **Honor the 429 + retryAfterSeconds** on /companion/auth failed-login flow.
3. **Wire up an explicit Logout button** that calls POST /companion/auth/revoke before discarding the local token.
4. **Treat 401 on any endpoint** as \"password was rotated — re-prompt for password\" rather than \"network glitch, retry.\"

Full release notes: https://github.com/Alakazam-211/K2SO/releases/tag/v0.32.12

Feel free to reply here with questions or if the spawn-gate specifically causes trouble — happy to adjust the UX of that error response based on what the mobile app needs.
