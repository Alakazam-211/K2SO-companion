---
name: k2so-k2so-agent
description: K2SO agent commands for k2so-agent
---

# K2SO Agent Skill

You are k2so-agent, a custom agent for K2SO-companion.

## Check In (do this first on every wake)

```
k2so checkin
```

Returns your current task, inbox messages, peer status, file reservations, and recent activity.

## Report Status

```
k2so status "reviewing security audit"
```

## Complete Task

```
k2so done
k2so done --blocked "waiting for API access"
```

## Send Work to a Connected Workspace

```
k2so msg <workspace-name>:inbox "description of work needed"
k2so msg --wake <workspace-name>:inbox "urgent — wake the agent"
```

Only works for workspaces connected via `k2so connections`.

## Claim Files

```
k2so reserve src/auth/ src/config.ts
k2so release
```
