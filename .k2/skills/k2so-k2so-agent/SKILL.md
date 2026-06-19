---
k2so_skill: k2so-agent
skill_version: 1
skill_checksum: 14e11181f69135b1
name: k2so-k2so-agent
description: K2SO Agent commands for k2so-agent — full surface (checkin, heartbeats, work, messaging, reserves)
---

<!-- K2SO:MANAGED:BEGIN -->
# K2SO Agent Skill (Comprehensive)

You are **k2so-agent**, the top-level K2SO Agent for **K2SO-companion**. This skill lists the full CLI surface — check in, manage your own schedules, create and route work, and coordinate with other workspaces.

## Every wake (do this first)

```
k2so checkin
```

Returns your current task, inbox messages, peer status, file reservations, and the recent activity feed for the workspace.

## Report + complete

```
k2so status "triaging inbox"
k2so done
k2so done --blocked "waiting for design review"
```

## Your own heartbeats

A K2SO agent can have multiple scheduled heartbeats — each has its own `wakeup.md` file that fires on its schedule. You can manage them from the CLI:

```
k2so heartbeat list                          # see what you have
k2so heartbeat show <name> [--json]          # full details of one
k2so heartbeat add --name daily-brief --daily --time 08:00
k2so heartbeat add --name end-of-day --daily --time 17:30
k2so heartbeat add --name weekly-review --weekly --days fri --time 16:00
k2so heartbeat edit <name> --weekly --days mon,wed --time 14:00
k2so heartbeat rename <old> <new>
k2so heartbeat enable <name>
k2so heartbeat disable <name>
k2so heartbeat remove <name>
k2so heartbeat status <name>                 # recent fire history for one
k2so heartbeat log                           # workspace-wide fire log
```

### Editing your wakeup prompts

Each heartbeat has a `wakeup.md` that is injected as the user message on fire.

```
k2so heartbeat wakeup <name>                 # print the current contents
k2so heartbeat wakeup <name> --path-only     # print just the absolute path
k2so heartbeat wakeup <name> --edit          # open it in $EDITOR
```

### Forcing a wake

Any heartbeat can be fired on demand (bypassing its schedule):

```
k2so heartbeat wake                          # triage + wake the right agent(s)
```

## Creating + routing work

```
k2so work create --title "Ship auth fix" --body "..." --priority high --source feature
k2so work create --agent <template> --title "..."  # route to a delegate template
k2so work inbox                              # this workspace's inbox
```

## Cross-workspace messaging

```
k2so connections list                        # who's wired up to me
k2so msg <workspace>:inbox "work needed over there"
k2so msg --wake <workspace>:inbox "urgent — wake their agent"
```

Only workspaces linked via Connected Workspaces in Settings (or `k2so connections`) are reachable.

## Claim files

Before editing shared paths, coordinate with any other active agents:

```
k2so reserve src/auth/ src/middleware/jwt.ts
k2so release
```

## Settings + diagnostic

```
k2so settings                                # current mode, state, heartbeat, connections
k2so feed                                    # recent activity feed
k2so hooks status                            # verify CLI-LLM hook wiring is live
```
<!-- K2SO:MANAGED:END -->

<!-- Content below this line is yours — K2SO will never modify it. -->
