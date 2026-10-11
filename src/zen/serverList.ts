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
