import { getBaseUrl, getToken } from "../api/client";
import { isTicketEventFrame } from "../api/feedbackPure";

// App-level live events: WS
// `/cli/sessions/events?path=&token=` (empty path = every app-level
// event). ONE socket per server, shared by every subscriber: the Tickets
// overlay (`feedback_changed` / `ticket_changed`, 0.43.3+) and the Agents
// list (`projects_changed`, pins). Frames carry ids only, so each
// subscriber debounces its burst into ONE refetch (300 ms, the desktop
// board's window). Both surfaces also poll, so a socket that never opens
// costs nothing but the poll.
//
// Close codes: 4001 = the login was revoked / token refused — stop, never
// spin on a dead token. 4008 = we lagged; reconnect and re-pull. Anything
// else reconnects with backoff (1 s doubling to 30 s). A `hello` whose
// `instance_id` changed means the daemon restarted: full refetch.

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
  base: string;
  subs: Set<Sub>;
  ws: WebSocket | null;
  attempt: number;
  everOpened: boolean;
  instanceId: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
};

const hubs = new Map<string, Hub>();

function baseKey(base: string): string {
  return (base || "").trim().replace(/\/+$/, "");
}

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
  if (hubs.get(hub.base) === hub) hubs.delete(hub.base);
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
  // Token read fresh each open (a revive mints a new one). Another server
  // active now: this hub's subscribers re-subscribe on the switch.
  if (baseKey(getBaseUrl()) !== hub.base) return;
  const url = ticketEventsUrl(hub.base, getToken() ?? "");
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
      killHub(hub); // revoked / refused token: never reconnect
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

/** Subscribe to app-level frames that `match`. Shares the server's socket. */
export function subscribeAppEvents(
  match: (frame: unknown) => boolean,
  onChange: () => void
): TicketEventsHandle {
  const base = baseKey(getBaseUrl());
  const sub: Sub = { match, onChange, debounce: null, stopped: false };
  if (!base || !getToken()) return { stop() {} }; // not connected: the poll carries it
  let hub = hubs.get(base);
  if (!hub) {
    hub = {
      base,
      subs: new Set(),
      ws: null,
      attempt: 0,
      everOpened: false,
      instanceId: null,
      retryTimer: null,
      dead: false,
    };
    hubs.set(base, hub);
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

export function connectTicketEvents(onChange: () => void): TicketEventsHandle {
  return subscribeAppEvents(isTicketEventFrame, onChange);
}

/** `{"kind":"projects_changed"}` (0.39.45+): pins / tab order / projects. */
export function isProjectsChangedFrame(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "projects_changed";
}

export function connectProjectEvents(onChange: () => void): TicketEventsHandle {
  return subscribeAppEvents(isProjectsChangedFrame, onChange);
}
