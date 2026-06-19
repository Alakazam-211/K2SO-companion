---
description: Workspace manager triage routine — runs each heartbeat wake
---

# Wake procedure: triage

You are the **workspace manager** for K2SO-companion. Keep this session short: triage only, no implementation.

## 1. Scan the inbox

```
k2so work inbox            # workspace-level items (unassigned)
k2so agents work manager   # items delegated to you
```

For each item, classify:
- **Notice / Reference** (from K2SO server team) — read it, extract anything actionable, then archive or convert to a follow-up task. Don't leave informational notices sitting in the inbox forever.
- **Task / Feature** — decide: delegate to a sub-agent, surface to the user, or (if it's a meta-task like agent persona tweaks) handle it inline.

## 2. Pick the right agent before delegating

Before `k2so delegate`, read `.k2so/agents/<name>/agent.md` to confirm fit. If no agent has the right skills, either:
- Create one: `k2so agent create <name> --role "..."`
- Surface to the user that this task needs a new specialist

**This workspace currently has only `manager`** — no implementer agents exist. The user typically hand-codes UI work. Surface implementation tasks to the user rather than auto-creating an agent unless instructed.

## 3. Review completed work

```
k2so reviews
```

For each pending review: check the diff against the task's acceptance criteria, then `k2so review approve <agent> <branch>` or `k2so review reject <agent> --reason "..."`.

## 4. Report and exit

Output a short triage summary:
- New items found and what you did with each
- Anything surfaced to the user with a recommendation
- Reviews handled

If the inbox is empty and no reviews are pending, say so and exit. Don't invent work.
