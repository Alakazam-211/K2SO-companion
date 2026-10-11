import { isTicketEventFrame } from "../api/feedbackPure";
import type { ServerScope } from "../api/scope";
import { onServerForget } from "../stores/servers";

// App-level live events: WS
// `/cli/sessions/events?path=&token=` (empty path = every app-level
// event). ONE socket per server (MS25 as amended by MA9), keyed by server
// id and shared by every subscriber: the Tickets overlay and the Zen
// feedback store (`feedback_changed` / `ticket_changed`, 0.43.3+) and the
// Agents list (`projects_changed`, pins). Frames carry ids only, so each
// subscriber debounces its burst into ONE refetch (300 ms, the desktop
// board's window). Both surfaces also poll, so a socket that never opens
// costs nothing but the poll.
//
// Multi-server (MS6): a hub is opened on a scope and every reopen builds
// its URL from THAT scope (fresh token). It never checks or follows the
// active server; subscribers on another server get their own hub.
//
// Close codes (daemon `session_events_ws.rs`): 4001 = this login was
// KICKED (removed from the server) — stop, never spin on it. 4003 =
// revoked, 4008 = we lagged; both reconnect and re-pull. Anything else
// reconnects with backoff (1 s doubling to 30 s). A `hello` whose
// `instance_id` changed means the daemon restarted: full refetch. (The
// per-code table of MS27/MA14 — revive on 4003, events backoff 500 ms →
// 5 s — lands with rooms in S3.)

export const TICKET_EVENT_DEBOUNCE_MS = 300;
const MAX_BACKOFF_MS = 30_000;

export type TicketEventsHandle = { stop: () => void };

export function ticketEventsUrl(base: string, token: string): string | null {
  const b = (base || "").trim().replace(/\/+$/, "");
  if (!b || !token) return null;
  return `${b.replace(/^http/i, "ws")}/cli/sessions/events?path=&token=${encodeURIComponent(token)}`;
}

type Sub = {
  match: (frame: unknown) => boolean;
  onChange: () => void;
  debounce: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
};

type Hub = {
  /** Server id (MA2: per-server memories key by id, not base URL). */
  key: string;
  scope: ServerScope;
  subs: Set<Sub>;
  ws: WebSocket | null;
  attempt: number;
  everOpened: boolean;
  instanceId: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
};

const hubs = new Map<string, Hub>();

// A removed or re-keyed server (MS3): close its hub. Its subscribers fall
// back to their polls; a re-subscribe dials the new address.
onServerForget((id) => {
  const hub = hubs.get(id);
  if (hub) killHub(hub);
});

function bump(sub: Sub) {
  if (sub.stopped) return;
  if (sub.debounce) clearTimeout(sub.debounce);
  sub.debounce = setTimeout(() => {
    sub.debounce = null;
    if (!sub.stopped) sub.onChange();
  }, TICKET_EVENT_DEBOUNCE_MS);
}

function bumpAll(hub: Hub) {
  for (const sub of hub.subs) bump(sub);
}

function killHub(hub: Hub) {
  hub.dead = true;
  if (hubs.get(hub.key) === hub) hubs.delete(hub.key);
  if (hub.retryTimer) clearTimeout(hub.retryTimer);
  hub.retryTimer = null;
  const ws = hub.ws;
  hub.ws = null;
  try {
    ws?.close();
  } catch {
    /* */
  }
}

function schedule(hub: Hub) {
  if (hub.dead || hub.retryTimer) return;
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** hub.attempt);
  hub.attempt += 1;
  hub.retryTimer = setTimeout(() => {
    hub.retryTimer = null;
    openHub(hub);
  }, delay);
}

function openHub(hub: Hub) {
  if (hub.dead) return;
  // Base + token read fresh from the hub's OWN scope each open (a revive
  // mints a new token). A removed server stops the hub.
  let url: string | null;
  try {
    url = ticketEventsUrl(hub.scope.httpBase(), hub.scope.token());
  } catch {
    killHub(hub);
    return;
  }
  if (!url) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch {
    schedule(hub);
    return;
  }
  hub.ws = sock;
  sock.onopen = () => {
    if (hub.dead || hub.ws !== sock) return;
    hub.attempt = 0;
    // A re-open may have missed frames while down: re-pull once.
    if (hub.everOpened) bumpAll(hub);
    hub.everOpened = true;
  };
  sock.onmessage = (e) => {
    if (hub.dead || hub.ws !== sock) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "hello") {
      const id = (frame as { instance_id?: unknown }).instance_id;
      const next = typeof id === "string" ? id : null;
      if (hub.instanceId && next && next !== hub.instanceId) bumpAll(hub);
      if (next) hub.instanceId = next;
      return;
    }
    for (const sub of hub.subs) if (sub.match(frame)) bump(sub);
  };
  sock.onclose = (e) => {
    if (hub.dead || hub.ws !== sock) return;
    hub.ws = null;
    if (e.code === 4001) {
      killHub(hub); // kicked from this server: never reconnect
      return;
    }
    schedule(hub);
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      /* */
    }
  };
}

/** Subscribe to app-level frames that `match` on `scope`'s server. Shares
 *  that server's socket. */
export function subscribeAppEvents(
  scope: ServerScope,
  match: (frame: unknown) => boolean,
  onChange: () => void
): TicketEventsHandle {
  const sub: Sub = { match, onChange, debounce: null, stopped: false };
  let connected = false;
  try {
    connected = !!scope.id && !!scope.httpBase() && !!scope.token();
  } catch {
    connected = false;
  }
  if (!connected) return { stop() {} }; // not connected: the poll carries it
  const key = scope.id;
  let hub = hubs.get(key);
  if (!hub) {
    hub = {
      key,
      scope,
      subs: new Set(),
      ws: null,
      attempt: 0,
      everOpened: false,
      instanceId: null,
      retryTimer: null,
      dead: false,
    };
    hubs.set(key, hub);
    hub.subs.add(sub);
    openHub(hub);
  } else {
    hub.subs.add(sub);
  }
  const owner = hub;
  return {
    stop() {
      if (sub.stopped) return;
      sub.stopped = true;
      if (sub.debounce) clearTimeout(sub.debounce);
      sub.debounce = null;
      owner.subs.delete(sub);
      if (owner.subs.size === 0) killHub(owner);
    },
  };
}

export function connectTicketEvents(scope: ServerScope, onChange: () => void): TicketEventsHandle {
  return subscribeAppEvents(scope, isTicketEventFrame, onChange);
}

/** `{"kind":"projects_changed"}` (0.39.45+): pins / tab order / projects. */
export function isProjectsChangedFrame(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "projects_changed";
}

export function connectProjectEvents(scope: ServerScope, onChange: () => void): TicketEventsHandle {
  return subscribeAppEvents(scope, isProjectsChangedFrame, onChange);
}
