---
title: Simplify UI: terminal list + add session
priority: high
assigned_by: user
created: 2026-04-12
type: task
source: manual
---

Narrow the app surface area to two core features:

1. Terminal list (main view)
   - Show all active terminals with workspace names and tab names
   - This replaces the current workspace-filtered view
   - Each terminal shows: workspace name, tab/session name, status

2. Add terminal button
   - Opens a modal to select which workspace to launch a new LLM session in
   - Uses the presets/spawn API to create the session
   - Modal shows workspace list

Remove:
- Hamburger menu / workspace drawer (WorkspaceRail component)
- Active sessions drawer button (SessionSwitcher component)  
- HeaderBar workspace switching UI

Keep:
- The main terminal list view (what is currently in the center)
- Terminal session view (ChatSession) for viewing/interacting with terminals
- Search overlay (optional, may still be useful in the add modal)

This simplifies navigation to: terminal list -> tap to view -> send messages. Plus an add button for new sessions.
