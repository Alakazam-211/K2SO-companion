// The server Zen is talking to (multi-server MS4/MS5, rooms MS21–MS23).
//
// Zen code never reads "the active server" directly: every request, socket
// and per-server memory it uses takes the scope from here.
//
//   - With no room open on another server, Zen talks to the ACTIVE server
//     (the list, and a chat opened from it) — exactly as before S3.
//   - With the multi-server flag on, opening a row from server B opens a
//     ROOM on B (`zenStore.openRoom`): `zenServerId()` becomes B, so the
//     thread routes, overlay socket, activity, Files, the Sessions drawer
//     and the terminal page all run on B's scope. `activeServerId` (the
//     default server: Tickets, classic pages) never changes (MS21).
//   - Hot cap 1 (MS22): there is one room server at a time. Opening a room
//     elsewhere moves it; every room socket is keyed on it and re-dials.
//
// A room on a removed server is closed by the store (never falls back).

import { create } from "zustand";
import { useServersStore, getActiveServer } from "../stores/servers";
import { scopeFor, type ServerScope } from "../api/scope";

type RoomServerState = {
  /** The open room's server when it is NOT the active server; null means
   *  Zen is on the active server (list, or a room on it). */
  serverId: string | null;
};

export const useRoomServer = create<RoomServerState>(() => ({ serverId: null }));

/** The open room's server, only when it is not the active one. */
export function roomServerId(): string | null {
  return useRoomServer.getState().serverId;
}

/** Move Zen to a room on `serverId` (null or the active id: back to the
 *  active server). Only `zenStore` calls this. */
export function setRoomServer(serverId: string | null): void {
  const active = useServersStore.getState().activeServerId;
  const next = serverId && serverId !== active ? serverId : null;
  if (useRoomServer.getState().serverId !== next) useRoomServer.setState({ serverId: next });
}

/** The id of the server Zen's current room / list belongs to. */
export function zenServerId(): string | null {
  return roomServerId() ?? getActiveServer()?.id ?? null;
}

/** The scope Zen talks to right now. Capture it ONCE per operation and pass
 *  it down; a retry or a late answer must use the captured scope. */
export function zenScope(): ServerScope {
  return scopeFor(zenServerId());
}

/** `zenScope()` as a hook: re-renders when the room's server changes. */
export function useZenScope(): ServerScope {
  const room = useRoomServer((s) => s.serverId);
  const active = useServersStore(
    (s) => s.servers.find((x) => x.id === s.activeServerId)?.id ?? null
  );
  return scopeFor(room ?? active);
}

/** Is Zen in a room on a server other than the active one? (hook) */
export function useRoomElsewhere(): boolean {
  return useRoomServer((s) => s.serverId !== null);
}

/** Tickets stay on the DEFAULT server in v1 (NG6, §13 Q1, MA34), whatever
 *  room is open. The default server is the active one (the Servers sheet's
 *  pinned card). Ticket surfaces (Tickets overlay, ticket view, waiting
 *  badge) use this, never the room's scope. */
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
