---
title: "Notice: Shadow terminal reflow is live on dev server — ready for testing"
priority: high
assigned_by: K2SO:manager
created: 2026-04-11
type: notice
source: manual
---

## Status

The shadow terminal reflow engine is implemented and running on the dev server right now. All existing endpoints are backwards compatible — HTTP 12/12 and WebSocket 13/13 tests passing.

## Dev Server

```
URL: https://k2.ngrok.app
Username: z3thon
Password: mr0ss0nl
```

## What's New

### `terminal.subscribe` now accepts mobile dimensions

```json
{ "id": "...", "method": "terminal.subscribe", "params": { "terminalId": "...", "cols": 50, "rows": 20 } }
```

When `cols` and `rows` are provided, the server reflows the terminal grid to those dimensions before sending `terminal:grid` events. Text wraps naturally at the mobile width, colors are preserved across wrap points.

Without `cols`/`rows`, behavior is unchanged (desktop grid dimensions).

### `terminal.resize` method

```json
{ "id": "...", "method": "terminal.resize", "params": { "terminalId": "...", "cols": 95, "rows": 30 } }
```

For phone rotation — resizes the shadow reflow dimensions in place. No need to re-subscribe. Server sends a fresh `full: true` grid at the new dimensions on the next update cycle.

### `terminal:grid` events — new `wrapped` field on lines

Each line in the grid now includes a `wrapped` boolean:

```json
{
  "row": 0,
  "text": "hello world this is a long line that",
  "spans": [...],
  "wrapped": true
}
```

`wrapped: true` means this line is a soft-wrap continuation of the previous line (the terminal wrapped at column boundary). `wrapped: false` means the program sent a hard newline. This helps the mobile renderer distinguish between intentional line breaks and reflow wraps.

## How Reflow Works

1. The server reads the desktop terminal grid (120 cols)
2. Uses the `wrapped` flags to reconstruct **logical lines** (joining soft-wrapped rows)
3. Re-wraps logical lines at the mobile width (e.g. 50 cols)
4. Splits color/style spans correctly across wrap points
5. Sends the reflowed grid as CompactLine data

Conversational text (assistant responses, tool descriptions) reflows cleanly. Cursor-positioned UI elements (permission prompts, status bars, progress bars) may still appear garbled — this is an accepted limitation since the underlying program formatted them for 120 columns.

## What to Test

1. Subscribe to a terminal with `{ cols: 50, rows: 20 }` (portrait phone)
2. Verify text wraps naturally at 50 columns
3. Verify colors are preserved across wraps
4. Send `terminal.resize` with `{ cols: 95, rows: 30 }` (landscape)
5. Verify content reflows to the new width
6. Check that existing behavior (no dims) still works unchanged

## Bug Fix: Prompt Line Wrapping (Two Fixes Applied)

**Fix 1: 1-column safety margin** — server subtracts 1 column from mobile dimensions for sub-pixel font rendering differences. `cols: 50` → reflow at 49.

**Fix 2: Trailing space padding trim** — desktop terminals pad each row with spaces to fill the full width (120+ cols). When soft-wrapped rows were joined into logical lines, that padding ended up in the middle, inflating short prompts like "bypass permissions on" to 120+ characters. The reflow now trims trailing spaces from each row before joining, so padded prompt/status lines fit within mobile width.

Both fixes are live on the dev server now. Reconnect and test — the prompt line wrapping should be significantly better.

## Not Yet Released

This is running on the dev server only. Will ship as v0.29.0 after integration testing is complete. The existing v0.28.10 production release is unaffected.
