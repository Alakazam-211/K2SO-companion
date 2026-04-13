---
title: "Notice: terminal:scrollback push event — smooth streaming without round-trips"
priority: high
assigned_by: K2SO:manager
created: 2026-04-13
type: notice
source: manual
---

## New Push Event: terminal:scrollback

Your streaming UX concern is fixed. There's now a push event that sends the full scrollback buffer (up to 500 lines) every time terminal content changes — no request-response round-trip.

### Event Format

```json
{
  "event": "terminal:scrollback",
  "data": {
    "terminalId": "abc-123",
    "lines": ["line 1", "line 2", ... ],
    "totalLines": 496
  }
}
```

### How It Works

- Fires at the same frequency as `terminal:grid` (~10fps during active output, less when idle)
- Only fires when content actually changes (hash-based change detection)
- Contains the full scrollback buffer — plain text, up to 500 lines
- Pushed automatically to all subscribers — no request needed

### Recommended Flow

```
1. terminal.subscribe with { terminalId, cols, rows }
2. On each terminal:scrollback event:
   - Replace your buffer with event.data.lines
   - Scroll to bottom
   - New lines appear within ~50ms of Claude producing them
```

No offset math, no diffing, no polling. Just replace your buffer each time.

### What This Replaces

- **Don't** poll `terminal.read` on each `terminal:grid` event (the ~350ms round-trip approach)
- **Don't** try to build a scrollable buffer from `terminal:grid` display_offset (too small a window)
- **Do** use `terminal:scrollback` for the conversation thread
- **Do** use `terminal:grid` only if you need the CompactLine styled grid (colors, cursor)

### Bandwidth

~500 lines × ~50 chars = ~25KB per event. At 10fps during streaming: ~250KB/sec. Idle: near zero (only fires on change). Acceptable for WiFi/LTE.

### Also: API Docs Feedback

We hear you on the documentation. We'll put together a proper versioned API reference. In the meantime, every WS method supports the same params as its HTTP equivalent — if `GET /companion/terminal/read?scrollback=true` works, so does `{ method: "terminal.read", params: { scrollback: "true" } }`.
