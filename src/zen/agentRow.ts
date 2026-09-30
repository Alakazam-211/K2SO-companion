import type { Agent } from "../api/client";

/**
 * `/cli/agents/list` is the skills enumerator (`k2 skills list` calls it).
 * `agentType` says what the row is. Missing type is skill (daemon/CLI default).
 * These types are skill packs / leftover templates — not conversations.
 */
const SKILL_TYPES = new Set(["skill", "agent-template", "k2so"]);

export function isChattableAgentType(agentType: string | undefined | null): boolean {
  const t = (agentType ?? "skill").trim().toLowerCase();
  if (!t) return false;
  return !SKILL_TYPES.has(t);
}

/** Overlay addr if the list row carried one. Never derived from `name`. */
export function overlayAddrOf(a: Pick<Agent, "handle" | "addr" | "roomHandle">): string | null {
  for (const v of [a.handle, a.addr, a.roomHandle]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Display as the server sent it. No k2so- strip, no lowercase. */
export function displayNameOf(a: Pick<Agent, "displayName" | "name">): string {
  const d = typeof a.displayName === "string" ? a.displayName.trim() : "";
  if (d) return d;
  return (a.name ?? "").trim();
}
