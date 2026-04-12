---
title: "Reference: Complete K2SO Companion API (v0.29.0-dev)"
priority: high
assigned_by: K2SO:manager
created: 2026-04-12
type: reference
source: manual
---

## Connection

**Server:** `https://k2.ngrok.app`
**Auth:** POST `/companion/auth` with Basic Auth → get Bearer token
**WebSocket:** `wss://k2.ngrok.app/companion/ws?token={token}`

All HTTP endpoints require `Authorization: Bearer {token}` header.
All HTTP endpoints through ngrok need `ngrok-skip-browser-warning: true` header.

---

## HTTP Endpoints (16)

### Auth
| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| POST | `/companion/auth` | Basic Auth header | Login, returns `{ token, expiresAt }` |

### Global (no `project` param needed)
| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| GET | `/companion/projects` | — | All workspaces with focusGroup, tabOrder, color, agentMode, pinned, iconUrl |
| GET | `/companion/projects/summary` | — | Workspaces with agentsRunning, reviewsPending, focusGroup, pinned, tabOrder (10KB vs 254KB for full) |
| GET | `/companion/sessions` | — | Active sessions across all workspaces with label, workspaceName, workspaceColor |
| GET | `/companion/presets` | — | Enabled CLI LLM tool presets (Claude, Codex, etc.) |

### Project-Scoped (require `?project=/path/to/workspace`)
| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| GET | `/companion/agents` | project | List agents in workspace |
| GET | `/companion/agents/running` | project | Running terminal sessions |
| GET | `/companion/agents/work` | project, agent?, folder? | Agent work items |
| POST | `/companion/agents/wake` | project, agent | Launch agent session |
| GET | `/companion/reviews` | project | Review queue |
| POST | `/companion/review/approve` | project, agent, branch | Approve review |
| POST | `/companion/review/reject` | project, reason? | Reject review |
| POST | `/companion/review/feedback` | project, message | Send feedback |
| GET | `/companion/terminal/read` | project, id, lines?, scrollback? | Read terminal buffer |
| POST | `/companion/terminal/write` | project, id, message | Send input to PTY |
| POST | `/companion/terminal/spawn` | project, command, title? | Launch new terminal with CLI tool |
| GET | `/companion/status` | project | Workspace mode/name |

### Terminal Read — Scrollback Support

```
GET /companion/terminal/read?project={path}&id={terminalId}&lines=50
```
Returns visible screen only (~63 lines).

```
GET /companion/terminal/read?project={path}&id={terminalId}&lines=500&scrollback=true
```
Returns up to 500 lines from scrollback history + visible screen, oldest to newest. Tested: 499 lines from a real Claude Code session.

---

## WebSocket Protocol (20 methods)

All messages are JSON. Requests have `id` + `method` + `params`. Responses have matching `id` + `result` or `error`. Push events have `event` + `data`.

### Methods

| Method | Params | Description |
|--------|--------|-------------|
| `auth` | `{ token }` | Authenticate (first message required) |
| `ping` | `{}` | Keepalive, returns `{ pong: true }` |
| `projects.list` | `{}` | All workspaces (global) |
| `projects.summary` | `{}` | Workspaces with counts (global) |
| `sessions.list` | `{}` | Active sessions across workspaces (global) |
| `presets.list` | `{}` | CLI LLM tool presets (global) |
| `agents.list` | `{ project }` | Agents in workspace |
| `agents.running` | `{ project }` | Running terminals |
| `agents.work` | `{ project, agent?, folder? }` | Work items |
| `agents.wake` | `{ project, agent }` | Launch agent session |
| `reviews.list` | `{ project }` | Review queue |
| `review.approve` | `{ project, agent, branch }` | Approve |
| `review.reject` | `{ project, reason? }` | Reject |
| `review.feedback` | `{ project, message }` | Feedback |
| `terminal.read` | `{ project, id, lines? }` | Read terminal buffer |
| `terminal.write` | `{ project, id, message }` | Send input to PTY |
| `terminal.spawn` | `{ project, command, title? }` | Launch new terminal |
| `terminal.subscribe` | `{ terminalId, cols?, rows? }` | Start grid streaming (with optional mobile reflow) |
| `terminal.resize` | `{ terminalId, cols, rows }` | Resize mobile reflow dimensions (for rotation) |
| `terminal.unsubscribe` | `{ terminalId }` | Stop grid streaming |
| `status` | `{ project }` | Workspace mode |

### Push Events (server → client)

| Event | Data | Description |
|-------|------|-------------|
| `heartbeat` | `{}` | Sent every 30s, keeps tunnel alive |
| `terminal:grid` | `{ terminalId, grid: GridUpdate }` | Terminal grid update (CompactLine) |
| `terminal:output` | `{ terminalId, lines: string[] }` | Legacy plain text (backwards compat) |
| `agent:lifecycle` | varies | Agent started/stopped |
| `agent:reply` | varies | Agent response |
| `sync:projects` | varies | Project metadata changed |

### Mobile Reflow (Shadow Terminal)

When you subscribe with `{ cols, rows }`, the server reflows the terminal grid to those dimensions:

```json
{ "id": "1", "method": "terminal.subscribe", "params": { "terminalId": "abc", "cols": 50, "rows": 20 } }
```

- Server applies 1-column safety margin (sends 49-col grid for `cols: 50`)
- Trims trailing padding spaces from each row before reflow
- Joins soft-wrapped rows into logical lines, re-wraps at mobile width
- Colors/styling preserved across wrap points
- `terminal:grid` events arrive at mobile dimensions

For phone rotation:
```json
{ "id": "2", "method": "terminal.resize", "params": { "terminalId": "abc", "cols": 95, "rows": 30 } }
```

Reflow dimensions update in place, next grid event uses new size.

### CompactLine Format

Each line in `terminal:grid` events:

```json
{
  "row": 0,
  "text": "hello world",
  "spans": [{ "s": 0, "e": 4, "fg": 16711680 }],
  "wrapped": true
}
```

- `row` — line index (0 = top)
- `text` — plain text content
- `spans` — style spans: `s`/`e` = start/end column, `fg`/`bg` = 0xRRGGBB color, `fl` = flags (1=bold, 2=italic, 4=underline, 8=strikethrough, 16=inverse, 32=dim)
- `wrapped` — true if this line is a soft-wrap continuation of the previous line

### iOS WebSocket Note

If iOS WKWebView blocks native WebSocket to external hosts, consider using `tauri-plugin-websocket` (Rust-side WebSocket client that bypasses WKWebView). This would give you access to all WS features including real-time grid streaming.

As a fallback, all functionality is available via HTTP endpoints + polling.

---

## Test Scripts

Run from the K2SO repo:

```bash
# HTTP tests (12)
./scripts/test-companion.sh https://k2.ngrok.app z3thon mr0ss0nl

# WebSocket tests (13)
./scripts/test-companion-ws.sh https://k2.ngrok.app z3thon mr0ss0nl
```
