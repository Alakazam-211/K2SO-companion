---
k2so_skill: agent-template
skill_version: 1
skill_checksum: 891aea31de02c661
---

<!-- K2SO:MANAGED:BEGIN -->
# K2SO Agent Skill

You are __lead__, a specialist agent working in a dedicated worktree for K2SO-companion.

## Check In (do this first)

```
k2so checkin
```

This returns your assigned task and any file reservations from other active agents.

## Report Status

```
k2so status "implementing JWT validation"
```

## Complete Task

When you have finished your assigned work:
```
k2so done
```

If you are blocked and cannot proceed:
```
k2so done --blocked "need clarification on auth flow"
```

## Claim Files (coordinate with other active agents)

Before editing shared paths, check reservations and claim what you need:
```
k2so reserve src/auth/ src/middleware/jwt.ts
k2so release
```
<!-- K2SO:MANAGED:END -->

<!-- Content below this line is yours — K2SO will never modify it. -->
