// Per-server signals from the sockets to the pool and the room (multi-server
// MS27 as amended by MA14). A tiny bus so `api/` and `zen/` sockets do not
// import the pool (`zen/multi/pool.ts`) or the room.
//
//   - `kicked`   — a sessions/events socket closed 4001: this login was
//                  removed from that server. No reconnect, no sign-in on
//                  its own; the row and the room say "Removed from {server}".
//   - `signin`   — a revive on that server (after a 4003, or a 1005 pair
//                  on the overlay socket) said the token is dead. The token
//                  is NOT deleted by a background socket (MA22).
//   - `lagged`   — a sessions/events socket closed 4008: re-pull snapshots.
//   - `reopened` — a socket for that server re-opened after a drop: frames
//                  may be missing, re-pull what the room shows.

export type ServerSignal = "kicked" | "signin" | "lagged" | "reopened";
type Listener = (serverId: string, signal: ServerSignal) => void;

const listeners = new Set<Listener>();

export function onServerSignal(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitServerSignal(serverId: string, signal: ServerSignal): void {
  if (!serverId) return;
  for (const fn of [...listeners]) {
    try {
      fn(serverId, signal);
    } catch {
      /* a listener never breaks a socket */
    }
  }
}
