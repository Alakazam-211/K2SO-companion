import { isTicketEventFrame } from "../api/feedbackPure";
import { emitHomesFrame } from "../api/homesSync";
import { emitStashFrame } from "../api/stashSync";
import type { ServerScope } from "../api/scope";
import { queueDial, type DialTicket } from "../api/dialQueue";
import { emitServerSignal, onServerSignal } from "../api/serverSignals";
import { inBackground, onAppLifecycle } from "../lib/appLifecycle";
import { revive } from "../lib/revive";
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
// Close codes (daemon `session_events_ws.rs`, MS27 as amended by MA14):
//   - 4001 = this login was KICKED (removed from the server): stop, never
//     reconnect, never sign in on its own; the pool and room hear it.
//   - 4003 = the token was REVOKED: one whoami check (revive on this
//     server, never deleting the token from here, MA22), then reconnect
//     while it still stands; a dead token stops the hub.
//   - 4008 = we LAGGED: reconnect at once and re-pull (every subscriber
//     refetches; the room re-pulls its snapshots).
//   - anything else: reconnect with backoff, 500 ms doubling to 5 s, each
//     delay drawn from [ms/2, ms] (desktop `lib/backoff.ts`).
// A `hello` whose `instance_id` changed means the daemon restarted: full
// refetch. Every (re)dial goes through the dial queue (MS26). With the
// multi-server flag on, the app's background closes every hub socket and
// the foreground reopens them (MS28).

export const TICKET_EVENT_DEBOUNCE_MS = 300;
export const EVENTS_BACKOFF_BASE_MS = 500;
export const EVENTS_BACKOFF_CAP_MS = 5_000;
export const WS_CLOSE_KICKED = 4001;
export const WS_CLOSE_REVOKED = 4003;
export const WS_CLOSE_LAGGED = 4008;

/** Events backoff for attempt `n` (0-based): 500 ms doubling to 5 s, with
 *  bounded jitter — the delay is in `[ms/2, ms]`. */
export function eventsBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const ms = Math.min(EVENTS_BACKOFF_CAP_MS, EVENTS_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ms / 2 + rand() * (ms / 2));
}

export type TicketEventsHandle = { stop: () => void };

export function ticketEventsUrl(base: string, token: string): string | null {
  const b = (base || "").trim().replace(/\/+$/, "");
  if (!b || !token) return null;
  return `${b.replace(/^http/i, "ws")}/cli/sessions/events?path=&token=${encodeURIComponent(token)}`;
}

type Sub = {
  match: (frame: unknown) => boolean;
  onChange: () => void;
  /** Frame subscribers get each matching frame at once (no debounce);
   *  `onChange` then runs only for a re-pull (reopen, restart). */
  onFrame?: (frame: unknown) => void;
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
  dial: DialTicket | null;
  /** Closed for the app's background; the foreground reopens it. */
  paused: boolean;
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

/** Close the hub's socket quietly (its close must not reconnect). */
function dropSocket(hub: Hub) {
  hub.dial?.cancel();
  hub.dial = null;
  if (hub.retryTimer) clearTimeout(hub.retryTimer);
  hub.retryTimer = null;
  const ws = hub.ws;
  hub.ws = null;
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close();
  } catch {
    /* */
  }
}

function killHub(hub: Hub) {
  hub.dead = true;
  if (hubs.get(hub.key) === hub) hubs.delete(hub.key);
  dropSocket(hub);
}

function schedule(hub: Hub, delay = eventsBackoffMs(hub.attempt)) {
  if (hub.dead || hub.paused || hub.retryTimer) return;
  hub.attempt += 1;
  hub.retryTimer = setTimeout(() => {
    hub.retryTimer = null;
    openHub(hub);
  }, delay);
}

/** 4003: whoami on this server first (never deleting the token from a
 *  background socket, MA22). A token that still stands reconnects. */
async function afterRevoked(hub: Hub) {
  const outcome = await revive(hub.scope, { background: true });
  if (hub.dead || hub.paused) return;
  if (outcome === "signin-required" || outcome === "not-applicable") {
    emitServerSignal(hub.key, "signin");
    killHub(hub);
    return;
  }
  schedule(hub);
}

function openHub(hub: Hub) {
  if (hub.dead || hub.paused || hub.dial || hub.ws) return;
  // MS28: in the background (flag on) the foreground reopens it.
  if (inBackground()) {
    hub.paused = true;
    return;
  }
  let started = false;
  const ticket = queueDial(hub.scope, () => {
    started = true;
    hub.dial = null;
    if (hub.dead || hub.paused) return null;
    return dialHub(hub);
  });
  if (!started) hub.dial = ticket;
}

function dialHub(hub: Hub): WebSocket | "failed" | null {
  // Base + token read fresh from the hub's OWN scope each open (a revive
  // mints a new token). A removed server stops the hub.
  let url: string | null;
  try {
    url = ticketEventsUrl(hub.scope.httpBase(), hub.scope.token());
  } catch {
    killHub(hub);
    return null;
  }
  if (!url) return null;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch {
    schedule(hub);
    return "failed";
  }
  hub.ws = sock;
  sock.onopen = () => {
    if (hub.dead || hub.ws !== sock) return;
    hub.attempt = 0;
    // A re-open may have missed frames while down: re-pull once.
    if (hub.everOpened) {
      bumpAll(hub);
      emitServerSignal(hub.key, "reopened");
    }
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
    // K2 0.46.1 Homes sync: `homes_changed` / `homes_device_removed` (and
    // 0.46.7 `stash_changed`) go to the sync engines at once (no debounce,
    // no subscriber needed).
    if (emitHomesFrame(hub.key, frame) || emitStashFrame(hub.key, frame)) return;
    for (const sub of hub.subs) {
      if (!sub.match(frame)) continue;
      if (sub.onFrame) {
        try {
          sub.onFrame(frame);
        } catch {
          /* one subscriber never breaks the hub */
        }
      } else bump(sub);
    }
  };
  sock.onclose = (e) => {
    if (hub.dead || hub.ws !== sock) return;
    hub.ws = null;
    const code = (e as CloseEvent | undefined)?.code;
    if (code === WS_CLOSE_KICKED) {
      // Kicked from this server: never reconnect, never sign in alone.
      emitServerSignal(hub.key, "kicked");
      killHub(hub);
      return;
    }
    if (code === WS_CLOSE_REVOKED) {
      void afterRevoked(hub);
      return;
    }
    if (code === WS_CLOSE_LAGGED) {
      emitServerSignal(hub.key, "lagged");
      hub.attempt = 0;
      schedule(hub, 0);
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
  return sock;
}

/** Subscribe to app-level frames that `match` on `scope`'s server. Shares
 *  that server's socket. */
export function subscribeAppEvents(
  scope: ServerScope,
  match: (frame: unknown) => boolean,
  onChange: () => void,
  onFrame?: (frame: unknown) => void
): TicketEventsHandle {
  const sub: Sub = { match, onChange, onFrame, debounce: null, stopped: false };
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
      dial: null,
      paused: false,
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

// Auto reconnect: the server answers again. A hub waiting on its backoff
// redials now (through the dial queue); the reopen re-pulls.
onServerSignal((id, signal) => {
  if (signal !== "recovered") return;
  const hub = hubs.get(id);
  if (!hub || hub.dead || hub.paused || hub.ws || hub.dial) return;
  if (hub.retryTimer) clearTimeout(hub.retryTimer);
  hub.retryTimer = null;
  hub.attempt = 0;
  openHub(hub);
});

// MS28 (flag on): the background closes every hub socket; the foreground
// reopens them through the dial queue, and the reopen re-pulls.
onAppLifecycle((phase) => {
  for (const hub of hubs.values()) {
    if (phase === "background") {
      hub.paused = true;
      dropSocket(hub);
    } else if (hub.paused) {
      hub.paused = false;
      hub.attempt = 0;
      // The reopen re-pulls (everOpened), like any reconnect.
      openHub(hub);
    }
  }
});

/** Tests: is a hub open (or dialling) for this server id? */
export function hubState(serverId: string): "none" | "paused" | "open" | "dialling" | "idle" {
  const hub = hubs.get(serverId);
  if (!hub) return "none";
  if (hub.paused) return "paused";
  if (hub.ws) return "open";
  if (hub.dial || hub.retryTimer) return "dialling";
  return "idle";
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

/** `{"kind":"notify_prefs_changed"}` (K2 0.45.5, `thread-push-v1`): someone
 *  changed push prefs. No payload; refetch your own `GET /cli/notify/prefs`. */
export function isNotifyPrefsChangedFrame(frame: unknown): boolean {
  return (
    !!frame &&
    typeof frame === "object" &&
    (frame as { kind?: unknown }).kind === "notify_prefs_changed"
  );
}

export function connectNotifyPrefsEvents(
  scope: ServerScope,
  onChange: () => void
): TicketEventsHandle {
  return subscribeAppEvents(scope, isNotifyPrefsChangedFrame, onChange);
}
