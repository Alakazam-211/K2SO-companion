// Cross-server hygiene for the workspaces store — pure decision logic,
// import-safe for the node harness (scripts/test-sessions-swap-pure.mjs).
//
// A workspaces snapshot BELONGS to one server. Same-server refreshes keep
// the old snapshot when a fetch fails (live-event refetches must never
// blank the list), but on an ACTIVE-SERVER IDENTITY change the previous
// server's data must never survive as phantom UI: a failed first fetch
// against the new server surfaces as empty/loading — not the old server's
// session list. Mirrors stores/projectGroups.ts (`forServerId`) and
// stores/feedback.ts (`loadedForServer`), which already carry this guard.

/** The server-scoped slice reset on an identity change. */
export interface ServerScopedReset {
  forServerId: string | null;
  projects: never[];
  summaries: never[];
  allSessions: never[];
  activeProjectId: null;
  activeFocusGroupId: null;
  error: null;
}

/**
 * Slice to apply before a refresh that targets `activeServerId` while the
 * in-memory data was loaded for `forServerId`. Null → same identity: keep
 * the current snapshot (old data survives a failed same-server refetch).
 */
export function serverSwapReset(
  forServerId: string | null,
  activeServerId: string | null
): ServerScopedReset | null {
  if (forServerId === activeServerId) return null;
  return {
    forServerId: activeServerId,
    projects: [],
    summaries: [],
    allSessions: [],
    activeProjectId: null,
    activeFocusGroupId: null,
    error: null,
  };
}

/**
 * True when a response that STARTED against `startedServerId` must be
 * dropped because the active server has since changed — an in-flight
 * old-server reply must never repollute the store after a swap.
 */
export function isStaleServerResponse(
  startedServerId: string | null,
  activeServerId: string | null
): boolean {
  return startedServerId !== activeServerId;
}
