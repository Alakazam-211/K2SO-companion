import type { ThreadItem } from "../api/client";
import type { ServerScope } from "../api/scope";
import { queueDial, type DialTicket } from "../api/dialQueue";
import { emitServerSignal, onServerSignal } from "../api/serverSignals";
import { emitHomesFrame } from "../api/homesSync";
import { inBackground, onAppLifecycle } from "../lib/appLifecycle";
import { revive } from "../lib/revive";
import { overlayEventsUrl } from "./threadLive";

export const OVERLAY_POLL_MS = 2000;
const SLOW_RETRY_MS = 60_000;
/** Overlay reconnect backoff (MA14): 1 s doubling to 15 s. */
export const OVERLAY_BACKOFF_BASE_MS = 1000;
export const OVERLAY_BACKOFF_CAP_MS = 15_000;
/** The overlay socket sends no 4001/4003/4008 (MA14): a token the daemon
 *  dropped shows up as a 1005. Two of them within this window ask whoami
 *  once (desktop `host-pool.ts` kick heuristic). */
export const OVERLAY_1005_WINDOW_MS = 5_000;

export function overlayBackoffMs(attempt: number): number {
  return Math.min(OVERLAY_BACKOFF_CAP_MS, OVERLAY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

/** K2 0.45.5 `thread-push-v1`: while a Thread is on screen the client
 *  says so, so the daemon skips pushing it. Fire-and-forget text frames,
 *  no ack; the server forgets a view after its TTL (90 s, PRD §6.4
 *  `visible_until = now + 90 s`), so repeat. */
export const VIEWING_REPEAT_MS = 30_000;

export type OverlayLiveHandle = {
  stop: () => void;
  /** `true` sends `{"t":"viewing","visible":true}` now (or on the next
   *  socket open) and every 30 s; `false` sends `visible:false` once, only
   *  after a `true` went out. Callers gate on `thread-push-v1`. */
  setViewing: (visible: boolean) => void;
};

/** Skin live path: WS `/cli/overlay/events?conversation=`. Token query
 *  because WebSocket cannot set Authorization. After two handshake
 *  failures, poll GET every 2s and retry the socket once a minute.
 *
 *  Multi-server (MS6/MA5): opened on `scope`; every reopen rebuilds its URL
 *  from that scope (fresh token), never from the active server. Dials go
 *  through the dial queue (MS26). Close codes (MA14): this socket has none
 *  of its own; a 1005 reconnects, and a second 1005 within 5 s asks whoami
 *  on this server once (never deleting the token, MA22) — a dead login
 *  stops the socket and tells the room. With the multi-server flag on the
 *  app's background closes it and the foreground reopens + catches up
 *  (MS28). */
export function connectOverlayEvents(opts: {
  scope: ServerScope;
  conversationId: string;
  onItem: (raw: ThreadItem) => void;
  onNeedCatchUp: () => void;
  /** Every socket open, first and re-open (activity catch-up: K2 never
   *  replays ephemeral `activity` frames). */
  onOpen?: () => void;
}): OverlayLiveHandle {
  let stopped = false;
  let ws: WebSocket | null = null;
  let handshakeFails = 0;
  let reconnectAttempt = 0;
  let everOpened = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wsTimer: ReturnType<typeof setTimeout> | null = null;
  let viewing = false;
  let viewTimer: ReturnType<typeof setInterval> | null = null;
  let dial: DialTicket | null = null;
  let paused = false;
  let last1005 = 0;
  let checking = false;

  /** Best-effort: a closed or opening socket just drops the frame. */
  function sendViewing(visible: boolean): boolean {
    const sock = ws;
    if (!sock || sock.readyState !== 1) return false;
    try {
      sock.send(JSON.stringify({ t: "viewing", visible }));
      return true;
    } catch {
      return false;
    }
  }

  function stopViewTimer() {
    if (viewTimer) clearInterval(viewTimer);
    viewTimer = null;
  }

  function startViewing() {
    stopViewTimer();
    sendViewing(true);
    viewTimer = setInterval(() => {
      if (!stopped && viewing) sendViewing(true);
    }, VIEWING_REPEAT_MS);
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    if (stopped || pollTimer) return;
    const tick = () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        opts.onNeedCatchUp();
      }
      pollTimer = setTimeout(tick, OVERLAY_POLL_MS);
    };
    pollTimer = setTimeout(tick, OVERLAY_POLL_MS);
  }

  function schedule(delay: number) {
    if (stopped || paused || wsTimer) return;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      open();
    }, delay);
  }

  /** Two 1005s within 5 s: is the login still good on THIS server? */
  async function check1005(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const outcome = await revive(opts.scope, { background: true });
      if (stopped) return;
      if (outcome === "signin-required" || outcome === "not-applicable") {
        emitServerSignal(opts.scope.id, "signin");
        stopSocket();
        return;
      }
      schedule(overlayBackoffMs(reconnectAttempt++));
    } finally {
      checking = false;
    }
  }

  function quiet(sock: WebSocket | null) {
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

  /** Close the socket and every timer; the handle stays usable. */
  function stopSocket() {
    dial?.cancel();
    dial = null;
    if (wsTimer) clearTimeout(wsTimer);
    wsTimer = null;
    const sock = ws;
    ws = null;
    quiet(sock);
  }

  function open() {
    if (stopped || paused || dial || ws) return;
    if (inBackground()) {
      paused = true;
      return;
    }
    let started = false;
    const ticket = queueDial(opts.scope, () => {
      started = true;
      dial = null;
      if (stopped || paused) return null;
      return dialNow();
    });
    if (!started) dial = ticket;
  }

  function dialNow(): WebSocket | "failed" | null {
    let url: string | null = null;
    try {
      url = overlayEventsUrl(opts.scope.httpBase(), opts.scope.token(), opts.conversationId);
    } catch {
      url = null; // ServerRemovedError: poll answers "removed" from its own scope
    }
    if (!url) {
      startPoll();
      return null;
    }
    let opened = false;
    try {
      ws = new WebSocket(url);
    } catch {
      handshakeFails += 1;
      if (handshakeFails >= 2) startPoll();
      schedule(handshakeFails >= 2 ? SLOW_RETRY_MS : overlayBackoffMs(handshakeFails));
      return "failed";
    }
    const sock = ws;
    sock.onopen = () => {
      if (stopped || ws !== sock) return;
      opened = true;
      handshakeFails = 0;
      reconnectAttempt = 0;
      const catchUp = everOpened || !!pollTimer;
      if (everOpened) emitServerSignal(opts.scope.id, "reopened");
      stopPoll();
      everOpened = true;
      if (catchUp) opts.onNeedCatchUp();
      // A (re)opened socket is a new viewer on the daemon: say so now.
      if (viewing) startViewing();
      opts.onOpen?.();
    };
    sock.onmessage = (e) => {
      if (stopped || ws !== sock) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return; /* non-JSON */
      }
      // K2 0.46.1: the person's Homes frames may ride this socket too; they
      // go to the Homes sync engine, never into the Thread.
      if (emitHomesFrame(opts.scope.id, frame)) return;
      try {
        opts.onItem(frame as ThreadItem);
      } catch {
        /* a bad item never breaks the socket */
      }
    };
    sock.onclose = (e?: CloseEvent) => {
      if (stopped || ws !== sock) return;
      ws = null;
      if (!opened) {
        handshakeFails += 1;
        if (handshakeFails >= 2) {
          startPoll();
          schedule(SLOW_RETRY_MS);
          return;
        }
        schedule(overlayBackoffMs(handshakeFails));
        return;
      }
      if (e?.code === 1005) {
        const now = Date.now();
        const second = last1005 > 0 && now - last1005 <= OVERLAY_1005_WINDOW_MS;
        last1005 = now;
        if (second) {
          last1005 = 0;
          void check1005();
          return;
        }
      }
      schedule(overlayBackoffMs(reconnectAttempt++));
    };
    sock.onerror = () => {
      sock.close();
    };
    return sock;
  }

  // MS28 (flag on): background closes; foreground reopens and catches up.
  const stopLifecycle = onAppLifecycle((phase) => {
    if (stopped) return;
    if (phase === "background") {
      paused = true;
      stopViewTimer();
      stopSocket();
      stopPoll();
    } else if (paused) {
      paused = false;
      handshakeFails = 0;
      reconnectAttempt = 0;
      // The reopen's onopen catches up (everOpened), like any reconnect.
      open();
    }
  });

  // Auto reconnect: the server answers again. A socket waiting on its
  // backoff (or polling after failed handshakes) redials now.
  const stopRecovered = onServerSignal((id, signal) => {
    if (signal !== "recovered" || id !== opts.scope.id) return;
    if (stopped || paused || ws || dial) return;
    if (wsTimer) clearTimeout(wsTimer);
    wsTimer = null;
    handshakeFails = 0;
    reconnectAttempt = 0;
    open();
  });

  open();
  return {
    setViewing(visible) {
      if (stopped || visible === viewing) return;
      viewing = visible;
      if (visible) startViewing();
      else {
        stopViewTimer();
        sendViewing(false);
      }
    },
    stop() {
      if (viewing) sendViewing(false);
      viewing = false;
      stopViewTimer();
      stopped = true;
      stopLifecycle();
      stopRecovered();
      stopPoll();
      dial?.cancel();
      dial = null;
      if (wsTimer) clearTimeout(wsTimer);
      wsTimer = null;
      try {
        ws?.close();
      } catch {
        /* */
      }
      ws = null;
    },
  };
}
