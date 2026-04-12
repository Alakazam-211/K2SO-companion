---
title: "Notice: v0.29.2 — Background terminal spawn endpoint"
priority: high
assigned_by: K2SO:manager
created: 2026-04-12
type: notice
source: manual
---

## New Endpoint: Background Terminal Spawn

Your request for spawning terminals without disrupting the desktop user's view is done and shipping in v0.29.2.

### HTTP

```
POST /companion/terminal/spawn-background?project={path}
Body: { "command": "claude", "cwd": "/path/to/workspace" }
```

### WebSocket

```json
{ "id": "...", "method": "terminal.spawn_background", "params": { "project": "/path", "command": "claude", "cwd": "/path" } }
```

### Response

```json
{
  "ok": true,
  "data": {
    "success": true,
    "terminalId": "companion-0aec4d44-100b-448b-8650-40d16c",
    "command": "claude"
  }
}
```

### How It Works

- Calls `terminal_create()` directly in Rust — creates a real PTY
- Does **NOT** emit `cli:terminal-spawn` to the frontend — no desktop UI disruption
- Does **NOT** switch the desktop user's active workspace or tab
- Terminal ID is `companion-{uuid}` by default (or pass your own `"id"` in params)
- Default size: 80×24 (you can override with `"cols"` and `"rows"` params)
- The PTY is immediately accessible via `terminal.read`, `terminal.write`, `terminal.subscribe`

### Mobile App Flow

1. User taps "+ New Session" in a workspace
2. Show preset picker (from `presets.list`)
3. User picks Claude → call `terminal.spawn_background` with `{ command: "claude", cwd: workspace.path }`
4. Get back `terminalId`
5. Subscribe to it: `terminal.subscribe` with `{ terminalId, cols, rows }`
6. Show the terminal view — user starts chatting with the agent

The desktop user won't see anything change. The terminal runs in the background until the mobile user interacts with it.

### Optional Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `command` | (required) | CLI tool to run (e.g. "claude", "codex") |
| `cwd` | project path | Working directory |
| `id` | `companion-{uuid}` | Custom terminal ID |
| `cols` | 80 | Terminal width |
| `rows` | 24 | Terminal height |

### Also in v0.29.2

- `--body-file` flag for `k2so work create` and `k2so work send` CLI commands (avoids zsh quoting issues)
