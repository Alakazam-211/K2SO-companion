/**
 * Live GET /cli/skin/agents (guest read-a, 8793, 2026-09-29):
 *   { agents: [{ displayName, handle, projectId }] }
 * Addr and fs workspace are `handle`. Name is `displayName`.
 * `roomHandle` is not sent — do not read it.
 * `projectId` is present; files still use handle (skin does).
 * Rows without a handle are dropped. Unrecognised shape is an error.
 */
export type SkinAgentRow = {
  handle?: string;
  displayName?: string;
  projectId?: string;
};

export function skinRoomOf(
  a: SkinAgentRow
): { handle: string; name: string } | null {
  const handle = typeof a.handle === "string" ? a.handle.trim() : "";
  if (!handle) return null;
  const name =
    (typeof a.displayName === "string" && a.displayName.trim()) || handle;
  return { handle, name };
}

export function skinInitials(name: string): string {
  const parts = String(name).trim().split(/[\s\-_]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

/** Live 200 is `{agents:[]}`. A bare array or any other shape is an error. */
export function parseSkinAgents(data: unknown): SkinAgentRow[] | null {
  if (Array.isArray(data)) return null;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { agents?: unknown }).agents)
  ) {
    return (data as { agents: SkinAgentRow[] }).agents;
  }
  return null;
}

/** Live GET /cli/agent/list (singular; loopback 60753, 2026-09-29):
 *   { ok: true, agents: [{ enabled, live, mode, name, path }] }
 * `k2 agent list` calls this route. `/cli/agents/list` (plural) is skills.
 * No handle/addr on the wire — do not invent one from name. */
export type OwnerAgentRow = {
  enabled?: unknown;
  live?: unknown;
  mode?: unknown;
  name?: unknown;
  path?: unknown;
  handle?: unknown;
  addr?: unknown;
};

export function ownerAgentOf(
  a: OwnerAgentRow
): { id: string; name: string; path: string; addr: string | null } | null {
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) return null;
  const path = typeof a.path === "string" ? a.path : "";
  const handle = typeof a.handle === "string" ? a.handle.trim() : "";
  const addrField = typeof a.addr === "string" ? a.addr.trim() : "";
  const addr = handle || addrField || null;
  return { id: name, name, path, addr };
}

/** Live 200 is `{ok, agents:[]}`. A bare array is the skills enumerator — error. */
export function parseOwnerAgents(data: unknown): OwnerAgentRow[] | null {
  if (Array.isArray(data)) return null;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { agents?: unknown }).agents)
  ) {
    return (data as { agents: OwnerAgentRow[] }).agents;
  }
  return null;
}
