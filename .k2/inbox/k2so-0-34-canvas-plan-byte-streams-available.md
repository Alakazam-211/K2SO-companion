---
title: K2SO 0.34 — byte streams, grow-boundary marker, and an invitation to build your own Alacritty
priority: high
assigned_by: K2SO:manager
created: 2026-04-23
type: feature
source: manual
---

## TL;DR

- Everything in your inbox about Frame streams (`terminal:grid`,
  CompactLine, shadow terminal) is still live and supported.
- **New in 0.34.x:** K2SO now publishes the raw PTY byte stream
  for every session alongside the Frame stream. Plus a new
  in-band APC marker that tells a local vte how to seal grow-phase
  paint into scrollback. This is the architecture behind K2SO
  desktop's own Kessel pane in 0.34.3+.
- **Invitation:** the companion team can (and should, for mobile
  fidelity) build your own mobile-native terminal emulator
  driven by these bytes. Reflow becomes perfect because YOUR
  emulator owns the grid at YOUR width — no more baked-width
  reflow fights.
- Implementation plumbing to expose bytes over the existing ngrok
  companion WS tunnel is landing next release; wire protocol is
  specified below so you can plan against it.

---

## Why this matters for mobile

Everything the last round of companion work bet on — CompactLine
streaming + the daemon-side shadow terminal that reflows at
mobile dims — was the right call at the time. But we kept hitting
a structural limit: **the daemon bakes ONE width into its grid,
then ships derived events to everyone.** A 40-col phone looking
at a session the daemon is painting at 120 cols can't reflow
Claude's boxes cleanly, because the boundaries are in the wrong
places.

The Canvas Plan addendum (`.k2so/prds/canvas-plan.md` in the
K2SO repo if you want the full read) locks in a different model:

> **A Session is an ordered, append-only byte stream from a
> single PTY lifetime, plus a small set of in-band semantic
> markers the daemon injects. Every derived state — grid,
> scrollback, Frame events, archive NDJSON — is a *projection*
> of the Session. Subscribers subscribe to the Session; each
> one picks its own projection.**

Concretely: the daemon owns bytes. Each client renders at its
own width by running its own vte locally. K2SO desktop's Kessel
pane does this now (Canvas Plan Phase 4/5, shipped in 0.34.3
internally). You can do the same on mobile with whatever
terminal emulator makes sense for iOS/Android — WezTerm's `mux`,
libvte, a port of alacritty_terminal to Swift, a WASM port,
even SwiftTerm. Whatever works. The byte stream is harness-
neutral PTY output; any vte on earth can consume it.

**What this fixes for mobile:**
- Reflow is perfect at whatever cols the phone is at. Rotate
  landscape? Reflow. Split-view? Reflow. Reopen a session 8
  hours later at a different width? Reflow.
- Selection is content-native. Your Term owns the grid; your
  selection is in Term coords.
- Find, search, scrollback: all become YOUR emulator's job.
  No more asking K2SO to add features one at a time.

**What this doesn't change:**
- CompactLine + `terminal:grid` events still flow for apps that
  want daemon-rendered semantic content (useful for embedded
  previews, Apple Watch, or anywhere a local vte is overkill).
- Auth, tunnel, pairing, session discovery — all the existing
  WS machinery stays.
- "Locked-screen push requires APNs / K2SO Cloud" — still true.
  This is a real-time streaming upgrade, not a push upgrade.

---

## The byte stream (what's available today on the daemon)

K2SO daemon 0.34.3+ exposes this endpoint directly (via the
daemon's loopback HTTP server, not yet through the ngrok tunnel
— see §"Companion tunnel exposure" below):

```
ws://127.0.0.1:<daemon_port>/cli/sessions/bytes?session=<UUID>&token=<daemon_token>&from=<offset>
```

**Protocol:**

1. HTTP upgrade → WebSocket.
2. Server sends one `session:ack` text envelope:
   ```json
   {
     "event": "session:ack",
     "payload": {
       "sessionId": "…",
       "fromOffset": 0,
       "currentFrontOffset": 0,
       "currentBackOffset": 48234
     }
   }
   ```
   `currentFrontOffset` is the earliest byte still in the ring;
   `currentBackOffset` is the next byte to be written. If
   `fromOffset < currentFrontOffset` the ring has evicted some
   of what you asked for — fall back to the on-disk byte archive
   (`<project>/.k2so/sessions/<id>/archive.bytes`) to backfill.
3. Server streams **binary** WebSocket frames, each one a chunk
   of PTY bytes in stream order. No framing, no per-chunk
   envelope; the chunks concatenate to the Session's byte
   stream starting at `fromOffset`.
4. Client → server: ignored except for `ping`/`close`.

**What you feed those bytes into: anything that speaks vte.**
ANSI escape sequences, UTF-8 text, SGR, CUP, alt-screen, mode
changes, bracketed paste — it's a PTY output stream. Run it
through your emulator at whatever width you want and the grid
+ scrollback build themselves.

### The grow_boundary APC marker

K2SO desktop opens every PTY at an oversized row count
(`GROW_ROWS = 500`) so harnesses like `claude --resume` paint
their full conversation into a big canvas. After that paint
settles, the daemon SIGWINCHes the PTY down to the user's real
window size. Claude then repaints at the new size.

The problem: the grow-phase paint + the post-SIGWINCH paint go
through the same byte stream. Without a marker, a local vte
would just render them sequentially, getting the grow paint
then a ClearScreen then the new paint — which is correct but
loses the grow content to the Clear.

Solution: at the exact byte offset between the two, K2SO
injects an **APC escape** into the byte stream:

```
ESC _ k2so:grow_boundary:<json-payload> BEL
```

Where:
- `ESC _` = `\x1b\x5f` (APC introducer)
- `<json-payload>` is a JSON object like
  `{"target_cols":80,"target_rows":24,"grow_rows":500,"reason":"idle"}`
- `BEL` = `\x07` (APC terminator)

Every modern terminal emulator silently discards APC escapes
it doesn't recognize (xterm convention). So a naive pipe
of bytes through your emulator still works — you'd just lose
the grow content to the subsequent ClearScreen, same as
today's shadow terminal.

To preserve it, run a **pre-vte APC filter** that scans bytes
for `\x1b_k2so:<kind>:<json>\x07`, strips k2so-namespace
escapes before they reach your emulator, and handles each as
a side effect. For `grow_boundary` specifically: when you
see it, push the current grid's content rows (cursor.row + 1
of them) into your scrollback, clear the live grid, resize
your emulator's view to `{target_cols, target_rows}`, THEN
continue processing subsequent bytes. The daemon's own
Kessel pane does exactly this (see
`crates/k2so-core/src/session/bytes_ring.rs` +
`src-tauri/src/commands/kessel_term.rs` in K2SO).

Reference implementation (Rust, stateful across byte chunks):
```rust
// Scan for `\x1b _ k2so: <body> \x07`. Buffers partial APC
// across read boundaries so an escape split between two WS
// frames reassembles correctly. Strips ALL APC escapes (k2so
// or not) from the clean byte stream you hand to vte.
```

Full source in the K2SO repo at
`src-tauri/src/commands/kessel_term.rs::ApcFilter` — ~100
lines, easy to port to whatever language you're targeting.

### Archive format for replay

When a client subscribes `from=0` to a session that started hours
ago, the ring has evicted most of the history. The daemon
persists a sibling archive:

```
<project>/.k2so/sessions/<session_id>/archive.bytes
```

This file is the Session byte stream from byte 0. No framing,
no rotation. Read `bytes [from, currentFrontOffset)` from the
file, then follow with the WS ring + live tail. That gives a
contiguous byte range from any offset.

---

## Companion tunnel exposure (WS over ngrok)

**Status: protocol designed; implementation landing next K2SO
release. Target ship: K2SO 0.34.4 or 0.35.0.**

The daemon's `/cli/sessions/bytes` WS today runs on loopback
only (127.0.0.1). The ngrok tunnel routes to the Tauri
companion server, not the daemon. So we need to either:

- (A) Add a byte-stream proxy inside the companion server that
  subscribes to the daemon's WS and forwards bytes to the
  mobile client over your existing companion WS.
- (B) Expose the daemon's WS through a second ngrok endpoint.

We're going with (A) — reuses your existing auth, pairing, and
heartbeat machinery. You keep the one companion WS you already
have; bytes become another event type on it.

### Planned protocol extension

Two new methods on the existing companion WS (`wss://<tunnel>/companion/ws`):

```json
{ "id": "uuid-1", "method": "terminal.bytes.subscribe",
  "params": { "terminalId": "<UUID>", "fromOffset": 0 } }
```

Response:
```json
{ "id": "uuid-1", "result": {
    "subscribed": true,
    "currentFrontOffset": 0,
    "currentBackOffset": 48234
} }
```

And:
```json
{ "id": "uuid-2", "method": "terminal.bytes.unsubscribe",
  "params": { "terminalId": "<UUID>" } }
```

Bytes flow as **binary WebSocket frames** on the same socket,
each with a small self-identifying header so you can multiplex
multiple terminal subscriptions on one WS:

```
[4 bytes]  magic: "K2BY"
[1 byte]   version: 0x01
[1 byte]   terminal_id length N (max 64)
[N bytes]  terminal_id as UTF-8
[8 bytes]  absolute byte offset in the Session (u64, big-endian)
[...]      payload bytes
```

A single binary frame is one chunk of bytes for one terminal.
Mix text (JSON method calls / events) and binary (byte chunks)
on the same WS — `tungstenite` supports this natively; your
existing parse-as-JSON path just ignores binary messages, and
vice versa.

**What you'll do mobile-side:**

1. On pane open: `terminal.bytes.subscribe` with the terminal
   id you'd subscribe to via `terminal.subscribe` today.
2. Route binary frames with matching `terminal_id` through
   your APC filter → your local emulator.
3. Render your emulator's grid at native mobile width.
4. On pane close: `terminal.bytes.unsubscribe`.

Your existing `terminal.subscribe` / `terminal:grid` flow keeps
working unchanged. You can run both side-by-side if you want
(e.g. main Chat view uses CompactLine for "tool card" visual
chrome; a dedicated "raw terminal" view uses the byte path for
full fidelity). Pick whichever projection serves each UI best.

---

## Outdated items we need to square with this

Your inbox has these earlier notes that this supersedes for the
byte-stream path (NOT for the Frame-stream path, which is
unchanged):

| Earlier note | Status after this change |
|---|---|
| `notice-shadow-terminal-ready-for-testing.md` | Still accurate for the Frame-stream path. For pixel-perfect mobile rendering, prefer the byte-stream path (this note). |
| `notice-terminal-scrollback-push-event.md` | Still accurate. Byte-stream scrollback is native to your local emulator; no separate push needed. |
| `feature-migrate-to-websocket-protocol.md` | Fully in effect. Byte-stream methods are additive to the existing 18 methods. |
| `k2so-0-33-0-release-persistent-agents-feature-companion-app-.md` | Still accurate. Daemon ownership of the tunnel + KeepAlive is load-bearing for the byte-stream path too. |
| Anything referencing "mobile dims sent on `terminal.subscribe`" | Still works but irrelevant to the byte path. Your emulator owns its dims; you don't need to tell K2SO what they are for byte-stream panes. |

---

## Why build your own Alacritty?

Because it makes every downstream problem smaller:

- **Reflow is free.** `term.resize(cols, rows)` on your local
  emulator rewraps scrollback at new cols natively. No round-trip
  to the daemon. No "mobile dims baked into the frame stream."
  Rotate the phone? Reflow. Split view? Reflow. Always.
- **Selection is free.** Your emulator owns the grid; your
  selection is a pair of content coords. Doesn't desync on
  scroll; doesn't break on resize; copy-as-text is a grid walk.
- **Find-in-scrollback is free.** Your emulator stores the
  scrollback; you search it locally.
- **Latency is lower.** Per-byte flow, no 100ms polling window.
- **Feature velocity is yours.** Want to ligate? Want to
  highlight URLs? Want a minimap? All local, all fast.

Languages and libraries that should work:
- **Swift:** SwiftTerm (Miguel de Icaza's port) is excellent
  for iOS. Or link alacritty_terminal via UniFFI if you want
  the reference implementation.
- **Kotlin (Android):** `term-tools`, or port alacritty_terminal
  via JNI, or adapt a lightweight vte crate to WASM and run it
  in a WebView.
- **Rust-powered cross-platform:** Tauri Mobile or Dioxus Mobile
  with alacritty_terminal for the hybrid React/Swift/Kotlin
  approach, though this is a heavier architectural bet.
- **Even JS/TS if you prefer:** xterm.js is battle-tested,
  renders in a canvas, does everything we need. The catch is
  performance on low-end phones with long scrollback — native
  will be noticeably snappier.

Our K2SO-desktop Kessel pane uses `alacritty_terminal::Term`
driven by a local APC filter + vte::Processor. That's one
reference; you're not bound by it.

---

## What we'd love your feedback on

1. **Terminal emulator choice.** Which library you pick for
   mobile shapes how we specify edge cases (e.g. if you use
   SwiftTerm, we'll make sure SwiftTerm's APC handling plays
   nicely with the `k2so:` namespace).
2. **Protocol feedback.** Is the binary-framing with
   `K2BY`-magic reasonable? Would you prefer terminal-id
   encoded separately vs inlined? Is u64 byte offset
   sufficient, or do you want seqno alongside?
3. **Coexistence with CompactLine.** For the main Chat view,
   are you leaning toward byte-stream + local emulator, or
   staying on CompactLine? Both are supported — we just want
   to know so we can prioritize accordingly.
4. **Mobile dim handling for the daemon PTY.** Even with
   byte-stream, the daemon's PTY has to be at SOME size. If
   the mobile is the only subscriber, should we shrink the PTY
   down to mobile dims on subscribe? (Currently it tracks the
   desktop's size.) Alternatively: leave PTY big, let mobile
   clip/horizontally-scroll for CUP content, bank on the fact
   that most TUIs reflow their output on size change.

---

## Work request (informal)

No hard deadline. We'd like you to:

1. Read this note + the Canvas Plan addendum in the K2SO repo.
2. Prototype one byte-stream render path in a throwaway branch —
   pick an emulator lib, wire up against the existing
   loopback-only endpoint (we can provide a dev-tunnel for you
   if needed), verify a full `claude --resume` session renders
   with colors + proper scrollback.
3. Send feedback on the protocol extension before we ship the
   tunnel-proxy. We want your hands on the wire format before
   it solidifies.

K2SO core team will land the `terminal.bytes.subscribe` proxy
in the next release; we'll coordinate a joint test once both
sides have the surfaces wired.

Exciting stuff. This is the moment the mobile experience gets
to be its own beast rather than a squished-down desktop view.

— K2SO core team
