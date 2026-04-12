---
title: "Notice: v0.29.0 — Shadow terminal for mobile-native rendering (coming soon)"
priority: normal
assigned_by: K2SO:manager
created: 2026-04-11
type: notice
source: manual
---

## What's Coming

K2SO v0.29.0 will introduce a **shadow terminal** system that renders terminal sessions at mobile screen dimensions server-side. Instead of receiving the desktop's 120-column grid and trying to wrap it on the phone, the mobile companion will receive grid data already rendered at the phone's actual screen width.

This is being developed in a feature branch and will be merged to main once tested and stable.

## What Changes for the Mobile App

### `terminal.subscribe` — New Parameters

The subscribe method will accept mobile screen dimensions:

```json
{ "id": "...", "method": "terminal.subscribe", "params": { "terminalId": "...", "cols": 50, "rows": 20 } }
```

The server creates a shadow terminal at those dimensions. The `terminal:grid` events you receive will contain CompactLine data already wrapped and rendered for your screen size — no client-side reflow needed.

### `terminal:grid` Events — Better Quality

Grid updates from the shadow terminal will have:
- Text naturally wrapped at your column width (not 120-col desktop width)
- Correct color spans across wrapped lines
- Proper line breaks (soft wraps distinguished from hard wraps via WezTerm-style reflow)

Cursor-positioned UI elements (permission prompts, status bars, progress bars) may still appear garbled because the underlying program formatted them for 120 columns. This is an accepted limitation — the shadow terminal is a monitoring view, not a full terminal replacement.

### Session Catch-Up

When you subscribe mid-session, the server replays a 2MB ring buffer of recent PTY history into the shadow terminal. You'll see recent output immediately instead of a blank screen that gradually fills in.

### No Breaking Changes

- All existing HTTP endpoints continue to work unchanged
- The WebSocket protocol is backwards compatible — `terminal.subscribe` without `cols`/`rows` falls back to the desktop grid (current behavior)
- `terminal:output` plain text events still sent alongside `terminal:grid`
- The `terminal.read` method still returns plain text

## What NOT to Change Yet

- Keep your current rendering code (TerminalView or ChatBubble) working
- Don't remove HTTP fallback paths
- Don't depend on the new `cols`/`rows` parameters until v0.29.0 is released

## Timeline

Being built in a feature branch. We'll notify you again when:
1. The branch is ready for testing (you can point at a dev server)
2. It's merged to main and released as v0.29.0

## Why This Matters

The current CompactLine streaming sends 120-column grid data to phones. Mobile-side wrapping breaks input lines, status bars, and UI chrome. The shadow terminal approach renders the same byte stream at phone dimensions server-side, producing output where conversational text wraps naturally while preserving colors and styling.

This is based on research into WezTerm (reflow algorithm), Mosh (differential sync), and sshx (ring buffer pattern). Details in the K2SO R&D ticket if you're curious.
