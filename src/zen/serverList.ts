/** Pure ordering/filtering for the Servers sheet. */

/** Active server first, then the rest alphabetically by display label
 *  (case-insensitive). Stable for equal labels. Does not mutate. */
export function sortServersActiveFirst<T extends { id: string }>(
  servers: readonly T[],
  activeId: string | null | undefined,
  labelOf: (s: T) => string
): T[] {
  const active = servers.find((s) => s.id === activeId);
  const rest = servers
    .filter((s) => s !== active)
    .map((s, i) => ({ s, i, label: labelOf(s) }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.i - b.i
    )
    .map((x) => x.s);
  return active ? [active, ...rest] : rest;
}

/** Case-insensitive substring match on any of the given fields.
 *  A blank query keeps everything. Preserves input order. */
export function filterServers<T>(
  servers: readonly T[],
  query: string,
  fieldsOf: (s: T) => Array<string | null | undefined>
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...servers];
  return servers.filter((s) =>
    fieldsOf(s).some((f) => !!f && f.toLowerCase().includes(q))
  );
}

/** Split for the Servers sheet: the active server (pinned above the list,
 *  never filtered) and every other server A–Z for the scrolling list. */
export function splitPinnedServer<T extends { id: string }>(
  servers: readonly T[],
  activeId: string | null | undefined,
  labelOf: (s: T) => string
): { pinned: T | null; others: T[] } {
  const pinned = servers.find((s) => s.id === activeId) ?? null;
  const others = sortServersActiveFirst(
    servers.filter((s) => s !== pinned),
    null,
    labelOf
  );
  return { pinned, others };
}

// ─── Connection status (server cards + Server settings) ───

type RecoveryKey = "connected" | "reconnecting" | "reauthenticating" | "signin-required";

/** Dot color per recovery state. */
export const RECOVERY_DOT: Record<RecoveryKey, string> = {
  connected: "#22c55e",
  reconnecting: "#f59e0b",
  reauthenticating: "#f59e0b",
  "signin-required": "#ef4444",
};

/** Lower-case state word under a server row. */
export const STATE_LABEL: Record<RecoveryKey, string> = {
  connected: "connected",
  reconnecting: "reconnecting…",
  reauthenticating: "re-authenticating…",
  "signin-required": "sign-in required",
};
