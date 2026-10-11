// The WebSocket dial queue (multi-server MS26 as amended by MA26). A port
// of desktop K2's `lib/grid-dial-queue.ts`, keyed by the saved server's id
// (MA2) instead of the host key.
//
//   - at most 2 handshakes in flight per server, 4 across every server;
//   - a handshake holds its slot until the socket's first open / error /
//     close, or 4 s, whichever comes first;
//   - 3 failed handshakes within 3 s back THAT server off for 8 s (its
//     waiters sleep; other servers keep dialling);
//   - for a non-grid socket a 4 s timeout only releases the slot: the
//     socket is not closed and it is not a failure (MA26). A grid dial
//     (`failOnTimeout`) counts its timeout as a failure, as desktop does.
//
// Every phone socket dials through here: the sessions/events hub
// (`zen/ticketEvents.ts`), the overlay Thread socket (`zen/overlayEvents.ts`)
// and the terminal grid (`api/gridSocket.ts`). When a slot is free the
// socket is built synchronously, inside `queueDial`, so a single server
// behaves exactly as before; only a burst waits.

export const MAX_DIALS_PER_SERVER = 2;
export const MAX_DIALS_TOTAL = 4;
export const HANDSHAKE_TIMEOUT_MS = 4_000;
export const FAIL_BURST_WINDOW_MS = 3_000;
export const FAIL_BURST_COUNT = 3;
export const DIAL_BACKOFF_MS = 8_000;

interface ServerDials {
  inflight: number;
  backoffUntil: number;
  recentFails: number[];
  wakeTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  key: string;
  run: () => void;
}

/** What `start` hands back: the socket it built, `"failed"` when building
 *  it threw (counts toward the burst), or null when it chose not to dial
 *  (no URL, stopped) — the slot is released either way. */
export type DialResult = WebSocket | "failed" | null;

export interface DialTicket {
  /** Drop a dial that is still waiting. No-op once it has started. */
  cancel(): void;
}

let total = 0;
const servers = new Map<string, ServerDials>();
const waiters: Waiter[] = [];

function stateOf(key: string): ServerDials {
  let st = servers.get(key);
  if (!st) {
    st = { inflight: 0, backoffUntil: 0, recentFails: [], wakeTimer: null };
    servers.set(key, st);
  }
  return st;
}

function hasRoom(key: string, now = Date.now()): boolean {
  const st = stateOf(key);
  if (st.backoffUntil > now) return false;
  return st.inflight < MAX_DIALS_PER_SERVER && total < MAX_DIALS_TOTAL;
}

/** Record a failed handshake on `key`'s server (3 in 3 s → 8 s backoff). */
export function noteDialFailure(key: string, now = Date.now()): void {
  const st = stateOf(key);
  st.recentFails.push(now);
  while (st.recentFails.length > 0 && now - st.recentFails[0] > FAIL_BURST_WINDOW_MS) {
    st.recentFails.shift();
  }
  if (st.recentFails.length >= FAIL_BURST_COUNT) {
    st.backoffUntil = now + DIAL_BACKOFF_MS;
    st.recentFails.length = 0;
    if (st.wakeTimer) clearTimeout(st.wakeTimer);
    st.wakeTimer = setTimeout(() => {
      st.wakeTimer = null;
      pump();
    }, DIAL_BACKOFF_MS);
  }
}

/** ms left on `key`'s backoff (0 = none). */
export function dialBackoffRemainingMs(key: string, now = Date.now()): number {
  return Math.max(0, stateOf(key).backoffUntil - now);
}

function release(key: string): void {
  const st = stateOf(key);
  st.inflight = Math.max(0, st.inflight - 1);
  total = Math.max(0, total - 1);
  pump();
}

/** Start every waiter that now has room, in FIFO order. */
function pump(): void {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i];
    if (hasRoom(w.key)) {
      waiters.splice(i, 1);
      w.run();
    } else {
      i += 1;
    }
  }
}

function begin(
  key: string,
  start: () => DialResult,
  failOnTimeout: boolean
): void {
  const st = stateOf(key);
  st.inflight += 1;
  total += 1;
  let ws: DialResult;
  try {
    ws = start();
  } catch {
    ws = "failed";
  }
  if (ws === "failed") {
    noteDialFailure(key);
    release(key);
    return;
  }
  if (!ws || typeof (ws as WebSocket).addEventListener !== "function") {
    // Not dialled, or a socket double without events: the slot covered
    // construction only.
    release(key);
    return;
  }
  const sock = ws;
  let settled = false;
  const settle = (failed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.removeEventListener("open", onOpen);
    sock.removeEventListener("error", onFail);
    sock.removeEventListener("close", onFail);
    if (failed) noteDialFailure(key);
    release(key);
  };
  const onOpen = () => settle(false);
  const onFail = () => settle(true);
  const timer = setTimeout(() => settle(failOnTimeout), HANDSHAKE_TIMEOUT_MS);
  sock.addEventListener("open", onOpen);
  sock.addEventListener("error", onFail);
  sock.addEventListener("close", onFail);
}

/**
 * Dial one socket for `scope`'s server through the queue. `start` builds
 * the socket (reading a fresh URL and token) when a slot is granted: at
 * once, synchronously, when there is room; otherwise later, in order.
 */
export function queueDial(
  scope: { readonly id: string },
  start: () => DialResult,
  opts: { failOnTimeout?: boolean } = {}
): DialTicket {
  const key = scope.id || "";
  const failOnTimeout = opts.failOnTimeout === true;
  if (hasRoom(key) && !waiters.some((w) => w.key === key)) {
    begin(key, start, failOnTimeout);
    return { cancel() {} };
  }
  const waiter: Waiter = { key, run: () => begin(key, start, failOnTimeout) };
  waiters.push(waiter);
  return {
    cancel() {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
    },
  };
}

/** Tests: handshakes in flight for one server (or all, with no key). */
export function dialsInFlight(key?: string): number {
  return key === undefined ? total : stateOf(key).inflight;
}

/** Tests: dials waiting for a slot. */
export function dialsWaiting(): number {
  return waiters.length;
}

/** Tests only. */
export function __resetDialQueueForTests(): void {
  total = 0;
  for (const st of servers.values()) if (st.wakeTimer) clearTimeout(st.wakeTimer);
  servers.clear();
  waiters.length = 0;
}
