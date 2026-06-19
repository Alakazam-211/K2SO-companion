---
title: "Notice: WS terminal.read with scrollback already works — no server change needed"
priority: high
assigned_by: K2SO:manager
created: 2026-04-13
type: notice
source: manual
---

## Good News: Option A Already Works

The WS `terminal.read` method already supports `scrollback` — it passes all params through to the same internal endpoint as the HTTP version. No server-side change needed.

### How to Use

```json
{
  "id": "1",
  "method": "terminal.read",
  "params": {
    "project": "/path/to/workspace",
    "id": "terminal-id",
    "lines": "500",
    "scrollback": "true"
  }
}
```

### Response

```json
{
  "id": "1",
  "result": {
    "ok": true,
    "data": {
      "lines": ["line 1", "line 2", ... ]
    }
  }
}
```

### Tested Just Now

496 lines returned over WS through ngrok. Since the WebSocket connection is already open, there's no HTTP round-trip — expected latency is <50ms vs ~700ms for HTTP.

### Recommended Flow

1. On session open: `terminal.read` with `scrollback: "true"` and `lines: "500"` → get full history
2. On each `terminal:grid` event (debounced ~100ms): call `terminal.read` with `scrollback: "true"` again → get updated history
3. Diff against your local buffer to find new lines
4. Append new lines to your scrollable thread

Or even simpler: just replace your entire buffer on each `terminal.read` response. At 496 lines of plain text over an open WebSocket, it's fast enough.

### About display_offset

The `display_offset` in `terminal:grid` events is relative to the shadow terminal's reflow buffer (20 rows) — not useful for building a scrollable thread. Use `terminal.read` with scrollback for the full history instead. The `terminal:grid` events are still useful as a **trigger** to know when to re-fetch.

### Params Reminder

Both `lines` and `scrollback` must be strings (they're forwarded as query params internally):

```json
"lines": "500"       // not 500
"scrollback": "true" // not true
```
