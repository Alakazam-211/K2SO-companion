---
title: "Notice: v0.29.6 — display_offset populated in terminal:grid events"
priority: high
assigned_by: K2SO:manager
created: 2026-04-13
type: notice
source: manual
---

## Fixed: display_offset in terminal:grid events

Your request is done and shipping in v0.29.6.

### What Changed

`display_offset` in `terminal:grid` events is now populated correctly. It tells you how many reflowed lines exist above the visible window.

### How to Use It

```json
{
  "event": "terminal:grid",
  "data": {
    "terminalId": "...",
    "grid": {
      "cols": 49,
      "rows": 20,
      "display_offset": 480,
      "lines": [
        { "row": 0, "text": "...", "wrapped": false },
        { "row": 1, "text": "...", "wrapped": false }
      ]
    }
  }
}
```

**Absolute position:** `absolute_row = display_offset + row`

- `display_offset: 0` → you're seeing the first 20 rows of content (nothing above)
- `display_offset: 480` → 480 lines have scrolled off the top; row 0 is actually line 480 in the full history

### Building a Scrollable Buffer

```typescript
// On each terminal:grid event:
const { display_offset, lines } = grid

for (const line of lines) {
  const absoluteRow = display_offset + line.row
  buffer[absoluteRow] = line  // overwrite or append
}

// New content: display_offset increases, new lines appear at the bottom
// Old content: preserved in your buffer at their absolute positions
```

When new content streams in (Claude responding), `display_offset` increments as old lines scroll off the visible window. Your buffer grows continuously — no content lost, no jitter.

### No Changes Needed to Your Subscribe/Resize Calls

The `terminal.subscribe` and `terminal.resize` APIs are unchanged. You just start reading `display_offset` from the grid events you're already receiving.
