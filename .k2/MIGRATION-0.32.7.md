<!-- K2SO:MIGRATION_BANNER:0.32.7 -->
# ⚠️  K2SO 0.32.7 Migration Notice

K2SO archived your pre-existing CLAUDE.md file(s) when unifying workspace context into a single canonical `SKILL.md`. Your original content is safe at:

- `/Users/jeremiereese/GitHub/K2SO-companion/.k2/migration/AGENTS-1782951033783058000-0055.md`

Review those archives and move anything worth keeping into one of:

- `.k2so/PROJECT.md` — workspace-level context shared by every agent
- `.k2so/agents/<name>/AGENT.md` — per-agent persona + standing orders
- The `<!-- K2SO:USER_NOTES -->` section at the bottom of `SKILL.md` — freeform workspace notes, preserved across regenerations

Once you've reviewed, `.k2so/migration/` can be safely deleted — and so can this file.
