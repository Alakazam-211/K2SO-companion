// `WS /cli/home-chat/events` (K2 0.46.13, brief §2.7; daemon
// `home_chat/events_ws.rs`, desktop `lib/home-chat/events-socket.ts`): one
// person's Home chat frames from one server.
//
//   - Its own socket, NOT `/cli/sessions/events` (a Voice & Chat only login
//     never gets that one). The login rides `?token=` (a WebSocket can't set
//     headers).
//   - The daemon allows 3 per login (429 `too_many_sockets`): ONE shared
//     socket per server here, however many subscribers (`subscribeHomeChat`
//     is ref-counted).
//   - Frames: `hello` first (chat, flags, the calls already ringing), then
//     `message`, `message_updated`, `deleted`, `read`, `reaction`, `typing`,
//     `member_removed`, `summary_changed` (also when the socket fell
//     behind), `status`, `call_ring`, `call_updated`. Unknown frames are
//     dropped.
//   - Pings every 25 s (the platform answers). A removed, disabled or
//     signed-out login closes with 4003.
//
// Reconnect (desktop's schedule, phone rules from `zen/overlayEvents.ts`):
// 2 s, 5 s, 15 s, then 30 s, each jittered over [ms/2, ms]; after 4 dials
// in a row that never opened, the gate is read again — chat off or
// unusable parks the socket until the gate opens; otherwise it keeps
// trying once a minute (the phone never gives up for good). The backoff
// starts over once a socket has stayed open 30 s. 4003 asks whoami on THIS
// server (never deleting the token): a dead login stops the socket and
// signals `signin`. Dials go through the dial queue; the app's background
// closes the socket and the foreground reopens it; the `recovered` server
// signal redials at once.

import type { ServerScope } from "./scope";
import { queueDial, type DialTicket } from "./dialQueue";
import { emitServerSignal, onServerSignal } from "./serverSignals";
import { inBackground, onAppLifecycle } from "../lib/appLifecycle";
import { jittered, STABLE_OPEN_MS } from "../lib/reconnect";
import { openSocket } from "../lib/netStats";
import { revive } from "../lib/revive";
import {
  arr,
  idOf,
  obj,
  parseHomeChatFlags,
  parseHomeChatMessage,
  strOrNull,
  type HomeChatFlags,
  type HomeChatMessage,
} from "./homeChatPure";
import { parseCall, parseHelloCall, parseRing, type HomeChatCall, type HomeChatRing } from "./homeChatCallsPure";
import { noteHomeChatLink, onHomeChatGate, refreshHomeChatGate } from "./homeChat";

export const HOME_CHAT_EVENTS_PATH = "/cli/home-chat/events";
/** Pauses before each reconnect; the last repeats. */
export const HOME_CHAT_EVENTS_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;
/** Dials in a row that never opened before the gate is read again. */
export const HOME_CHAT_EVENTS_DEAD_TRIES = 4;
/** After that (the gate still open): one try a minute. */
export const HOME_CHAT_EVENTS_SLOW_RETRY_MS = 60_000;
/** The daemon's close for a removed, disabled or signed-out login. */
export const HOME_CHAT_CLOSE_REVOKED = 4003;

// ─── Frames ───

export type HomeChatFrame =
  | {
      type: "hello";
      chat: string | null;
      flags: HomeChatFlags;
      /** Rings in progress for you when the socket opened. */
      rings: HomeChatRing[];
      /** Every call you can see now (ringing or not), with Sew's call. */
      calls: Array<{ ring: HomeChatRing; call: HomeChatCall | null }>;
    }
  | { type: "status"; chat: string | null }
  | { type: "message"; conv: string; message: HomeChatMessage }
  | { type: "message_updated"; conv: string; message: HomeChatMessage }
  | { type: "deleted"; conv: string; id: string }
  | { type: "read"; conv: string }
  | {
      type: "reaction";
      conv: string;
      msg: string;
      emoji: string;
      on: boolean;
      /** The chip's new count (0 drops it). */
      count: number;
      member: string | null;
      /** Your own reaction: only then does `me` change. */
      mine: boolean;
    }
  | { type: "typing"; conv: string; member: string }
  | { type: "member_removed"; conv: string }
  | { type: "summary_changed"; conv: string | null }
  | { type: "call_ring"; conv: string; ring: HomeChatRing }
  | { type: "call_updated"; conv: string; call: HomeChatCall };

/** A reaction frame's emoji: Sew's `{kind: "unicode", value}`, or a string. */
function emojiOf(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  const e = obj(v);
  return e && e.kind === "unicode" && typeof e.value === "string" && e.value ? e.value : null;
}

/** One frame (a JSON string or an already-parsed object); null for junk or
 *  a type this build doesn't know. */
export function parseHomeChatFrame(data: unknown): HomeChatFrame | null {
  let v: Record<string, unknown> | null;
  if (typeof data === "string") {
    try {
      v = obj(JSON.parse(data));
    } catch {
      return null;
    }
  } else {
    v = obj(data);
  }
  if (!v) return null;
  const conv = idOf(v.conv);
  switch (v.type) {
    case "hello": {
      const calls = arr(v.calls)
        .map(parseHelloCall)
        .filter((c): c is { ring: HomeChatRing; call: HomeChatCall | null } => c !== null);
      return {
        type: "hello",
        chat: strOrNull(v.chat),
        flags: parseHomeChatFlags(v.flags),
        rings: calls.filter((c) => c.ring.ringing).map((c) => c.ring),
        calls,
      };
    }
    case "status":
      return { type: "status", chat: strOrNull(v.chat) };
    case "message":
    case "message_updated": {
      const message = parseHomeChatMessage(v.message);
      if (!message) return null;
      return { type: v.type, conv: conv ?? message.conv, message };
    }
    case "deleted": {
      const id = idOf(v.id);
      return conv && id ? { type: "deleted", conv, id } : null;
    }
    case "read":
      return conv ? { type: "read", conv } : null;
    case "member_removed":
      return conv ? { type: "member_removed", conv } : null;
    case "summary_changed":
      return { type: "summary_changed", conv };
    case "typing": {
      const member = idOf(v.member);
      return conv && member ? { type: "typing", conv, member } : null;
    }
    case "reaction": {
      const msg = idOf(v.msg);
      const emoji = emojiOf(v.emoji);
      if (!conv || !msg || !emoji) return null;
      const count = typeof v.count === "number" && Number.isFinite(v.count) ? Math.max(0, Math.floor(v.count)) : 0;
      return { type: "reaction", conv, msg, emoji, on: v.on === true, count, member: idOf(v.member), mine: v.mine === true };
    }
    case "call_ring": {
      const ring = parseRing(v.d);
      return ring ? { type: "call_ring", conv: conv ?? ring.conv, ring } : null;
    }
    case "call_updated": {
      const call = parseCall(v.d);
      return call ? { type: "call_updated", conv: conv ?? call.conv, call } : null;
    }
    default:
      return null;
  }
}

/** `wss://host/cli/home-chat/events?token=…`; null without a base or token. */
export function homeChatEventsUrl(wsBase: string, token: string): string | null {
  const b = (wsBase || "").trim().replace(/\/+$/, "");
  if (!b || !token) return null;
  const ws = b.replace(/^http/i, (h) => (h.toLowerCase() === "https" ? "wss" : "ws"));
  return `${ws}${HOME_CHAT_EVENTS_PATH}?${new URLSearchParams({ token }).toString()}`;
}

/** Pause before reconnect attempt `n` (0-based), before jitter. */
export function homeChatRetryMs(attempt: number): number {
  const i = Math.min(Math.max(0, attempt), HOME_CHAT_EVENTS_RETRY_MS.length - 1);
  return HOME_CHAT_EVENTS_RETRY_MS[i];
}

// ─── The shared socket per server ───

export interface HomeChatLinkInfo {
  /** The socket is open. */
  up: boolean;
  /** It opened again after a drop: frames may be missing (re-read the
   *  summary and the open chat; `hello` follows). */
  reopened: boolean;
}

interface Sub {
  onFrame: (frame: HomeChatFrame) => void;
  onLink?: (info: HomeChatLinkInfo) => void;
}

interface Hub {
  scope: ServerScope;
  subs: Set<Sub>;
  ws: WebSocket | null;
  dial: DialTicket | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  deadTries: number;
  openedAt: number;
  everOpened: boolean;
  up: boolean;
  paused: boolean;
  /** Chat is off/unusable: no dials until the gate opens. */
  parked: boolean;
  /** The login is dead here: no dials until a `recovered` signal. */
  dead: boolean;
  stopped: boolean;
  checking: boolean;
  unhook: Array<() => void>;
}

const hubs = new Map<string, Hub>();

function tell(hub: Hub, info: HomeChatLinkInfo): void {
  for (const s of [...hub.subs]) {
    try {
      s.onLink?.(info);
    } catch {
      /* a subscriber never breaks the socket */
    }
  }
}

function setUp(hub: Hub, up: boolean, reopened = false): void {
  if (hub.up === up) return;
  hub.up = up;
  tell(hub, { up, reopened });
}

function quiet(sock: WebSocket | null): void {
  if (!sock) return;
  sock.onopen = null;
  sock.onmessage = null;
  sock.onclose = null;
  sock.onerror = null;
  try {
    sock.close();
  } catch {
    /* */
  }
}

function stopSocket(hub: Hub): void {
  hub.dial?.cancel();
  hub.dial = null;
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = null;
  const sock = hub.ws;
  hub.ws = null;
  quiet(sock);
  hub.openedAt = 0;
  setUp(hub, false);
}

function idle(hub: Hub): boolean {
  return hub.stopped || hub.paused || hub.parked || hub.dead;
}

function schedule(hub: Hub, ms: number): void {
  if (idle(hub) || hub.timer || hub.ws || hub.dial) return;
  hub.timer = setTimeout(() => {
    hub.timer = null;
    open(hub);
  }, ms);
}

/** After a dial that never opened. */
function afterDeadTry(hub: Hub): void {
  hub.deadTries += 1;
  if (hub.deadTries < HOME_CHAT_EVENTS_DEAD_TRIES) {
    schedule(hub, jittered(homeChatRetryMs(hub.attempt++)));
    return;
  }
  // Is chat still on here? (A 404 `home_chat_off` or 503 refuses the
  // upgrade, which the socket only sees as a failed dial.)
  void refreshHomeChatGate(hub.scope, { force: true }).then((g) => {
    if (hub.stopped) return;
    if (!g.offered && g.refusal?.kind !== "network" && g.refusal?.kind !== "retry" && g.refusal?.kind !== "server") {
      hub.parked = true;
      return;
    }
    schedule(hub, jittered(HOME_CHAT_EVENTS_SLOW_RETRY_MS));
  });
}

/** 4003: whoami on this server first (a background socket never deletes
 *  the token). A login that still stands reconnects. */
async function afterRevoked(hub: Hub): Promise<void> {
  if (hub.checking) return;
  hub.checking = true;
  try {
    const outcome = await revive(hub.scope, { background: true });
    if (hub.stopped) return;
    if (outcome === "signin-required" || outcome === "not-applicable") {
      hub.dead = true;
      emitServerSignal(hub.scope.id, "signin");
      return;
    }
    schedule(hub, jittered(homeChatRetryMs(hub.attempt++)));
  } finally {
    hub.checking = false;
  }
}

function open(hub: Hub): void {
  if (idle(hub) || hub.dial || hub.ws) return;
  if (inBackground()) {
    hub.paused = true;
    return;
  }
  let started = false;
  const ticket = queueDial(hub.scope, () => {
    started = true;
    hub.dial = null;
    if (idle(hub)) return null;
    return dialNow(hub);
  });
  if (!started) hub.dial = ticket;
}

function dialNow(hub: Hub): WebSocket | "failed" | null {
  let url: string | null;
  try {
    url = homeChatEventsUrl(hub.scope.wsBase(), hub.scope.token());
  } catch {
    // The server was removed: nothing to dial, ever.
    hub.dead = true;
    return null;
  }
  if (!url) {
    // Signed out here (no token yet): look again in a minute, or at once
    // on `recovered`.
    queueMicrotask(() => schedule(hub, HOME_CHAT_EVENTS_SLOW_RETRY_MS));
    return null;
  }
  let sock: WebSocket;
  try {
    sock = openSocket("chat", url);
  } catch {
    afterDeadTry(hub);
    return "failed";
  }
  hub.ws = sock;
  let opened = false;
  sock.onopen = () => {
    if (hub.stopped || hub.ws !== sock) return;
    opened = true;
    hub.openedAt = Date.now();
    hub.deadTries = 0;
    const reopened = hub.everOpened;
    hub.everOpened = true;
    setUp(hub, true, reopened);
  };
  sock.onmessage = (e: MessageEvent) => {
    if (hub.stopped || hub.ws !== sock) return;
    const f = parseHomeChatFrame(typeof e.data === "string" ? e.data : String(e.data));
    if (!f) return;
    if (f.type === "hello") noteHomeChatLink(hub.scope, { flags: f.flags, chat: f.chat });
    else if (f.type === "status") noteHomeChatLink(hub.scope, { chat: f.chat });
    for (const s of [...hub.subs]) {
      try {
        s.onFrame(f);
      } catch {
        /* a bad subscriber never breaks the socket */
      }
    }
  };
  sock.onclose = (e?: CloseEvent) => {
    if (hub.stopped || hub.ws !== sock) return;
    hub.ws = null;
    const stable = hub.openedAt > 0 && Date.now() - hub.openedAt >= STABLE_OPEN_MS;
    hub.openedAt = 0;
    setUp(hub, false);
    if (!opened) {
      afterDeadTry(hub);
      return;
    }
    if (stable) hub.attempt = 0;
    if (e?.code === HOME_CHAT_CLOSE_REVOKED) {
      void afterRevoked(hub);
      return;
    }
    schedule(hub, jittered(homeChatRetryMs(hub.attempt++)));
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

function wake(hub: Hub): void {
  if (hub.stopped || hub.paused || hub.ws || hub.dial) return;
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = null;
  hub.attempt = 0;
  hub.deadTries = 0;
  open(hub);
}

function makeHub(scope: ServerScope): Hub {
  const hub: Hub = {
    scope,
    subs: new Set(),
    ws: null,
    dial: null,
    timer: null,
    attempt: 0,
    deadTries: 0,
    openedAt: 0,
    everOpened: false,
    up: false,
    paused: false,
    parked: false,
    dead: false,
    stopped: false,
    checking: false,
    unhook: [],
  };
  hub.unhook.push(
    onAppLifecycle((phase) => {
      if (hub.stopped) return;
      if (phase === "background") {
        hub.paused = true;
        stopSocket(hub);
      } else if (hub.paused) {
        hub.paused = false;
        wake(hub);
      }
    }),
    onServerSignal((id, signal) => {
      if (id !== scope.id || signal !== "recovered") return;
      hub.dead = false;
      wake(hub);
    }),
    onHomeChatGate((id, gate) => {
      if (id !== scope.id || !hub.parked || !gate.offered) return;
      hub.parked = false;
      wake(hub);
    })
  );
  return hub;
}

/** Hear `scope`'s Home chat frames. The first subscriber opens the
 *  server's one socket; the last unsubscribe closes it. `onLink` hears the
 *  socket open and close (at once with `up: true` if it already is).
 *  Gate first (`homeChatOffered`): this never checks it before dialling. */
export function subscribeHomeChat(
  scope: ServerScope,
  onFrame: (frame: HomeChatFrame) => void,
  opts: { onLink?: (info: HomeChatLinkInfo) => void } = {}
): () => void {
  const key = scope.id;
  let hub = hubs.get(key);
  if (!hub || hub.stopped) {
    hub = makeHub(scope);
    hubs.set(key, hub);
  }
  const sub: Sub = { onFrame, onLink: opts.onLink };
  hub.subs.add(sub);
  if (hub.up) {
    try {
      sub.onLink?.({ up: true, reopened: false });
    } catch {
      /* */
    }
  }
  if (hub.subs.size === 1) open(hub);
  const h = hub;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    h.subs.delete(sub);
    if (h.subs.size > 0) return;
    h.stopped = true;
    stopSocket(h);
    for (const u of h.unhook) u();
    h.unhook = [];
    if (hubs.get(key) === h) hubs.delete(key);
  };
}

/** Is `serverId`'s Home chat socket open now? */
export function homeChatLinkUp(serverId: string): boolean {
  return hubs.get(serverId)?.up ?? false;
}

/** Tests only: close every socket and forget the hubs. */
export function __resetHomeChatEventsForTests(): void {
  for (const h of hubs.values()) {
    h.stopped = true;
    stopSocket(h);
    for (const u of h.unhook) u();
  }
  hubs.clear();
}
