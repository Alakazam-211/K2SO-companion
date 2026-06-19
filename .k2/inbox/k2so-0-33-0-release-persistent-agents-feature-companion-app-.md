---
title: K2SO 0.33.0 release — persistent-agents feature, companion-app impact
priority: normal
assigned_by: external
created: 2026-04-19
type: feedback
source: manual
---

K2SO 0.33.0 ships shortly. Flagship feature: agents keep running when
the laptop lid is closed, via a new k2so-daemon process that launchd
keeps alive 24/7. Four things for the companion app team to know and
— where flagged — change.

---

## 1. Tunnel URL lifecycle changed

**Pre-0.33.0:** the Tauri app owned the ngrok tunnel. URL rotated
when the user relaunched K2SO — roughly once per day for active users.

**In 0.33.0:** the daemon owns the tunnel. It stays running across
Tauri app close, logout, reboot (via launchd KeepAlive). URL now
rotates only on:

- Daemon crash + KeepAlive restart (rare)
- `launchctl unload` (user action)
- OS updates that kill launchd agents
- macOS automatic reboot

Net: URL rotations are meaningfully rarer than before, BUT the companion
app still has no way to discover a new URL once the pairing breaks.

**Action requested:**

- Recommend paid-tier ngrok reserved domain for any user who relies on
  the companion daily. The daemon reads `companion.ngrok_domain` from
  settings and pins the tunnel across reconnects — reserved domain
  gives a stable URL forever.
- Consider a "reachability indicator" in the companion header:
  green = connected, yellow = last-seen N minutes ago, red = handshake
  failing. Right now the app has no feedback loop when the URL goes
  stale.
- Optional: add an "enter new tunnel URL" manual-repair path so a
  user whose free-tier URL rotated doesn't have to unpair + repair
  from scratch.

---

## 2. Socket behavior — server-side is now always on

**What changed:** closing the Tauri app no longer tears down the
WebSocket. The daemon keeps it live.

**What DID NOT change:**

- iOS suspends background socket connections within ~30 seconds.
- Lock screen still blocks all non-APNs delivery.
- "Phone rings when an agent needs you" still requires APNs.

**Action: honesty in your changelog copy.**

If the companion app's "What's New" for this K2SO release mentions
"agents keep working in the background", pair it with:

> "Delivery while the companion app is in the foreground works as
> expected. Background + locked-screen delivery requires the future
> K2SO Cloud service (coming in a later release) — Apple's platform
> does not allow self-hosted servers to push to a locked iPhone."

---

## 3. PushTarget trait (power-user feature) — you don't need to
##    integrate, just be aware

K2SO 0.33.0 ships a pluggable `PushTarget` interface with three
implementations:

- `NoOp` — default, no push at all
- `Webhook` — user's own HTTP endpoint
- `NtfySh` — ntfy.sh self-host or SaaS

These are server-to-user-endpoint pushes. They're NOT mobile-app
pushes. The companion app does not need to do anything to support
them.

**Action for the help/about screen:**

A one-liner somewhere visible:

> "For notifications outside this app (desktop banner, phone via
> ntfy.sh, custom webhook), configure a Push Target in K2SO → Settings
> → Mobile Companion."

That's it — no integration work.

---

## 4. No wire protocol changes

- WebSocket auth flow unchanged
- Event names unchanged (`terminal:grid`, `terminal:grid_delta`,
  `agent:lifecycle`, `agent:reply`, `sync:projects`, `sync:settings`,
  `cli:terminal-spawn*`, `cli:ai-commit`, `hook-injection-failed`)
- JSON payload shapes unchanged
- Bearer token format + 24h TTL unchanged
- ngrok / CORS / allowlist settings read from same `settings.json`
  paths

Existing companion-app builds continue working against the 0.33.0
server without modification.

---

## 5. Minor — new Settings panel in K2SO

**Settings → Wake Scheduler** lets the user pick:

- Off — no heartbeat plist, nothing fires when K2SO is closed
- On-demand — heartbeats only fire while K2SO is open
- Heartbeat every N minutes — launchd fires the plist every N min
  - "Wake system from sleep" checkbox — lets launchd wake a
    sleeping laptop (lid closed, on battery) for lid-closed
    overnight agent work

This is a K2SO UI surface, not a companion-app concern. Mentioned so
support conversations like "why didn't agents fire overnight" have
an answer: "check Settings → Wake Scheduler → mode should be
'heartbeat' and 'Wake System' checked."

---

## TL;DR for the changelog

- Agents keep running when K2SO is closed (via daemon process).
- WebSocket stays live across Tauri app restarts.
- No API changes for companion clients.
- Free-tier ngrok rotations are rarer now, but still happen — paid
  tier reserved domain is the real fix.
- Locked-screen push is **not** in 0.33.0. That's the future paid
  K2SO Cloud tier.

Ship to whatever user comms channel you use. Happy to review copy
before it goes out if you want.

— K2SO core team
