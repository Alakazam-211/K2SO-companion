---
title: "Feature: Migrate to WebSocket-first protocol for all API calls + rich terminal rendering"
priority: high
assigned_by: K2SO:manager
created: 2026-04-10
type: feature
source: manual
---

## Summary

The K2SO desktop app now supports a full WebSocket-first protocol on the companion API. All 18 API methods are available over a single persistent WebSocket connection, plus real-time CompactLine terminal streaming with colors, cursor position, and styling. The mobile app should migrate from HTTP REST to WebSocket for better performance, real-time updates, and rich terminal rendering.

**The server is live and tested. This is a mobile-app-only change.**

## What's Available Now

### Connection

The companion server accepts WebSocket at:
```
wss://k2.ngrok.app/companion/ws?token={session_token}
```

The existing HTTP auth (`POST /companion/auth` with Basic Auth) still works for getting the initial session token. Then open a WebSocket connection with the token in the query param.

### Message Protocol

All communication is JSON over WebSocket with request/response correlation via message IDs.

**Request (client → server):**
```json
{ "id": "uuid-1", "method": "projects.list", "params": {} }
```

**Response (server → client):**
```json
{ "id": "uuid-1", "result": { "ok": true, "data": [...] } }
```

**Error response:**
```json
{ "id": "uuid-1", "error": { "code": 400, "message": "Missing project" } }
```

**Push event (server → client, no id):**
```json
{ "event": "terminal:grid", "data": { "terminalId": "...", "grid": {...} } }
{ "event": "agent:lifecycle", "data": { ... } }
{ "event": "heartbeat" }
```

### Available Methods (18)

| Method | Params | Notes |
|--------|--------|-------|
| `auth` | `{ token }` | Validate token (can also use query param) |
| `ping` | `{}` | Returns `{ pong: true }` — keepalive |
| `projects.list` | `{}` | All workspaces (global, no project needed) |
| `projects.summary` | `{}` | Workspaces with agentsRunning + reviewsPending |
| `sessions.list` | `{}` | Active sessions across all workspaces |
| `agents.list` | `{ project }` | Agents in a workspace |
| `agents.running` | `{ project }` | Running terminal sessions |
| `agents.work` | `{ project, agent?, folder? }` | Agent work items |
| `agents.wake` | `{ project, agent }` | Launch agent session |
| `reviews.list` | `{ project }` | Review queue |
| `review.approve` | `{ project, agent, branch }` | Approve review |
| `review.reject` | `{ project, reason? }` | Reject review |
| `review.feedback` | `{ project, message }` | Send feedback |
| `terminal.read` | `{ project, id, lines? }` | Read terminal buffer |
| `terminal.write` | `{ project, id, message }` | Send input to PTY |
| `terminal.subscribe` | `{ terminalId }` | Start receiving grid updates |
| `terminal.unsubscribe` | `{ terminalId }` | Stop receiving grid updates |
| `status` | `{ project }` | Workspace mode/name |

### Heartbeat / Keepalive

- Server sends `{ "event": "heartbeat" }` every 30 seconds
- Client should send `{ "id": "...", "method": "ping" }` every 30 seconds
- This keeps the ngrok tunnel alive — no more disconnections

### Rich Terminal Streaming (CompactLine)

When you subscribe to a terminal via `terminal.subscribe`, the server pushes grid updates as `terminal:grid` events:

```json
{
  "event": "terminal:grid",
  "data": {
    "terminalId": "abc-123",
    "grid": {
      "cols": 120,
      "rows": 38,
      "cursor_col": 5,
      "cursor_row": 12,
      "cursor_visible": true,
      "cursor_shape": "Block",
      "full": true,
      "lines": [
        {
          "row": 0,
          "text": "$ npm test",
          "spans": [{ "s": 0, "e": 1, "fg": 5263440 }]
        },
        {
          "row": 1,
          "text": "PASS src/app.test.ts"
        }
      ]
    }
  }
}
```

**CompactLine format:**
- `row` — line index (0 = top of visible area)
- `text` — plain text content (trailing spaces trimmed)
- `spans` — style spans for non-default cells (empty or omitted = all default)
  - `s` / `e` — start/end column (inclusive)
  - `fg` — foreground color as `0xRRGGBB` integer (omitted if default `0xe0e0e0`)
  - `bg` — background color as `0xRRGGBB` integer (omitted if default `0x0a0a0a`)
  - `fl` — attribute flags (omitted if 0): `1`=bold, `2`=italic, `4`=underline, `8`=strikethrough, `16`=inverse, `32`=dim

**Update types:**
- `full: true` — complete grid snapshot (sent on subscribe and reconnect)
- `full: false` — only changed rows (sent for incremental updates)

**Rate:** ~10fps (100ms polling interval), only sends when content changes.

### Legacy Compatibility

The existing HTTP endpoints and the old WebSocket subscribe format (`{ "type": "subscribe", "terminalId": "..." }`) still work. The mobile app can migrate incrementally — no breaking changes.

The old `terminal:output` events (plain text lines) are also still sent alongside the new `terminal:grid` events.

## What to Build

### 1. Upgrade `websocket.ts`

Add `request(method, params): Promise<Result>` that:
- Generates a UUID message ID
- Sends `{ id, method, params }` over WS
- Returns a Promise that resolves when a response with matching `id` arrives
- Times out after 10 seconds

Handle incoming messages:
- If `id` field present → route to pending Promise resolver
- If `event` field present → route to event handlers (existing pattern)

Add heartbeat: send `ping` every 30 seconds.

On reconnect: re-send auth, re-subscribe all terminals.

### 2. Add WS variants to `client.ts`

```typescript
// Alongside existing HTTP functions:
export const getProjectsWs = () => ws.request('projects.list', {})
export const getSessionsWs = () => ws.request('sessions.list', {})
// etc.
```

### 3. Build `TerminalView` component

A React component that renders CompactLine data as colored terminal output:
- Each line → `<div>` with monospace font
- Each span → `<span>` with CSS: `fg` → `color: rgb(r,g,b)`, `bg` → `backgroundColor`, flags → bold/italic/underline
- Maintain full grid buffer (indexed by row), merge diff updates
- Cursor rendering at `cursorRow`/`cursorCol`
- Dark background (`#0a0a0a`), default text color (`#e0e0e0`)

**Important:** The terminal grid dimensions (cols/rows) reflect the desktop terminal size, which will be wider than the mobile screen. Handle this with horizontal scroll or a viewport that shows the most relevant portion.

### 4. Update `ChatSession.tsx`

- Subscribe via `ws.request('terminal.subscribe', { terminalId })`
- Listen for `terminal:grid` events → update `TerminalView` state
- Keep input bar at bottom for `terminal.write`
- Remove HTTP polling fallback (`setInterval(loadBuffer, 3000)`)

### 5. Migrate stores to WS

Replace `api.getProjects()` → `api.getProjectsWs()` etc. in workspaces and agents stores. The WS push events (`agent:lifecycle`, `sync:projects`) now carry data in the new envelope format: `{ "event": "agent:lifecycle", "data": "..." }`.

## Test Server

```
URL: https://k2.ngrok.app
Username: z3thon
Password: mr0ss0nl
```

Tested and verified: all 18 WS methods working, CompactLine streaming active, heartbeat sending, HTTP backwards compat (11/11 tests passing).
