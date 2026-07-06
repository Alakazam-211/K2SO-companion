---
k2_skill: k2-cli
skill_version: 6
skill_checksum: 2614e9ca09f49628
name: k2-cli
description: K2 CLI reference — msg, inbox, activity, connections, heartbeat
---

<!-- K2:MANAGED:BEGIN -->
# K2 CLI

How to drive the K2 agent system from a workspace via the `k2` CLI.

## Send work to a workspace
```
k2 msg <workspace-name> "live chat — appears in the running session"
k2 msg <workspace-name> --inbox --title "..." --body "..."   # queue (email-style)
```
`msg` (live form) fails loudly when the recipient isn't running — use `--inbox`
to queue a task the recipient reads on its own schedule.

## View activity
```
k2 activity [--limit N] [--workspace <path>]
```

## View connections
```
k2 connections list
```

## Compose a work item
```
k2 inbox compose --title "Fix login bug" --body "Users can't log in after reset"
```

## Ask a human
```
k2 feedback ask "<title>" [--body "..."] [--options "a,b,c"] [--wait]
k2 feedback list                               # your asks + their status
k2 feedback show <id>                          # one ask: status, answer, thread
```
`feedback ask` files a durable question on your human's Feedback page — it
survives your session and the answer comes back to you. Use it instead of a
dead terminal prompt when you need a decision or approval.

## Projects
A Project is a named GROUP of workspaces sharing one chat + one PoC agent.
```
k2 project read [<name>]         # catch up on the project's shared chat
k2 project msg [<name>] "..."    # post to the shared chat
```
If a message arrives prefixed `[project:<name>]`, it came from that project's
shared chat — reply with `k2 project msg <name> "your reply"`. Never use
`k2 msg <name>` for this: `<name>` is a Project, not a workspace, and
`k2 msg` will fail with `workspace_not_found`.

## Heartbeats
```
k2 heartbeat                                   # list active schedules
k2 heartbeat schedule list [--archived]
k2 heartbeat show <name> [--json]
k2 heartbeat schedule add --name <n> --daily --time HH:MM
k2 heartbeat signal wakeup <name>              # print/edit the WAKEUP.md
k2 heartbeat signal fire <name>                # fire now (skip schedule window)
k2 heartbeat signal wake                       # auto-wake (no name needed)
```
Run `k2 heartbeat --help` for the full surface.
<!-- K2:MANAGED:END -->

<!-- Content below this line is yours — K2 will never modify it. -->
<!-- Content below this line is yours — K2 will never modify it. -->
