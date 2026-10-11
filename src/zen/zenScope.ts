// The server Zen is talking to (multi-server S1, MS4/MS5).
//
// Zen code never reads "the active server" directly: every request, socket
// and per-server memory it uses takes the scope from here. In S1 the Zen
// room server IS the active server, so behaviour is unchanged. S3 (rooms on
// any server, MS21) changes `zenServerId()` to the open room's server
// without touching the call sites.

import { useServersStore, getActiveServer } from "../stores/servers";
import { scopeFor, type ServerScope } from "../api/scope";

/** The id of the server Zen's current room / list belongs to. */
export function zenServerId(): string | null {
  return getActiveServer()?.id ?? null;
}

/** The scope Zen talks to right now. Capture it ONCE per operation and pass
 *  it down; a retry or a late answer must use the captured scope. */
export function zenScope(): ServerScope {
  return scopeFor(zenServerId());
}

/** `zenScope()` as a hook: re-renders when the room's server changes. */
export function useZenScope(): ServerScope {
  const id = useServersStore(
    (s) => s.servers.find((x) => x.id === s.activeServerId)?.id ?? null
  );
  return scopeFor(id);
}

/** Tickets stay on the DEFAULT server in v1 (NG6), whatever room is open.
 *  The default server is the active one (the Servers sheet's pinned card).
 *  Ticket surfaces (Tickets overlay, ticket view, waiting badge) use this,
 *  never the room's scope. */
export function ticketsScope(): ServerScope {
  return scopeFor(getActiveServer()?.id ?? null);
}

/** `ticketsScope()` as a hook. */
export function useTicketsScope(): ServerScope {
  const id = useServersStore(
    (s) => s.servers.find((x) => x.id === s.activeServerId)?.id ?? null
  );
  return scopeFor(id);
}
