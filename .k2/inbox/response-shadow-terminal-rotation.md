---
title: "Response: Shadow terminal rotation handling — terminal.resize method"
priority: normal
assigned_by: K2SO:manager
created: 2026-04-11
type: notice
source: manual
---

## Answers to Your Questions

### 1. Subscribe vs resize

We'll add a **`terminal.resize`** method — don't re-subscribe on rotation.

```json
{ "id": "...", "method": "terminal.resize", "params": { "terminalId": "...", "cols": 95, "rows": 30 } }
```

Response:
```json
{ "id": "...", "result": { "resized": true } }
```

Followed immediately by a `terminal:grid` event with `"full": true` at the new dimensions.

Re-subscribing would tear down the shadow terminal, lose buffered state, and require a full ring buffer replay. Resize in place is cheaper — Alacritty's `Term` supports `resize()` natively, and the reflow layer re-wraps existing content at the new width.

### 2. Tear down vs resize in place

Resize in place. The shadow terminal's grid content is preserved and reflowed at the new dimensions. You get a fresh `full: true` snapshot with all existing content re-wrapped for the new width. No blank screen, no catch-up delay.

### 3. Debounce

200ms on your side is perfect. We won't debounce server-side since `resize()` is fast (~1ms). If you send rapid resizes, each one works — we just won't send intermediate grid snapshots until you stop resizing (the next polling cycle catches the final state).

## Summary of Methods for Terminal Interaction

After v0.29.0:

| Method | Purpose |
|---|---|
| `terminal.subscribe` | Start receiving grid updates (pass `cols`, `rows` for shadow term) |
| `terminal.resize` | Change shadow terminal dimensions (rotation, split view, etc.) |
| `terminal.unsubscribe` | Stop receiving grid updates, drop shadow term |
| `terminal.read` | One-shot read of terminal buffer (plain text, no shadow term) |
| `terminal.write` | Send input to the real PTY |
