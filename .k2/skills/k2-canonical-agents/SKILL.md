---
k2_skill: k2-canonical-agents
skill_version: 1
skill_checksum: 006a9a37611a9cc3
name: k2-canonical-agents
description: Set up or refresh the canonical AGENTS.md from existing harness files (run with an AI assistant)
---

<!-- K2:MANAGED:BEGIN -->
# K2 Canonical Agents

Operator for the canonical workspace-context shape. Run this WITH an AI
assistant so it merges existing content with judgment rather than overwriting.

## The shape
- `.k2/agent/AGENT.md` — persona (authored).
- `.k2/PROJECT.md` — project context (authored).
- `.k2/AGENTS.md` — canonical, GENERATED from the two above.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules` — read-only mirrors that
  symlink to `.k2/AGENTS.md`. (AGENTS.md is the cross-tool standard; CLAUDE.md is
  the bridge for Claude Code, which doesn't read AGENTS.md natively.)
- Skills (`.k2/skills/<name>/SKILL.md`) are loadable capabilities, not the entrypoint.

## Set up an EXISTING project (merge, don't clobber)
1. Read any existing `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` in the workspace.
2. Fold persona-ish guidance into `.k2/agent/AGENT.md` and project facts into
   `.k2/PROJECT.md`, preserving the user's wording.
3. Regenerate: the daemon composes `.k2/AGENTS.md` and lays the symlinks.
4. Confirm each harness entrypoint now resolves to `.k2/AGENTS.md`.

## A NEW project
No existing files to preserve — enabling fan-out generates `.k2/AGENTS.md` and
lays the symlinks directly.
<!-- K2:MANAGED:END -->

<!-- Content below this line is yours — K2 will never modify it. -->
