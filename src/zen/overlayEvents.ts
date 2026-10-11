import type { ThreadItem } from "../api/client";
import type { ServerScope } from "../api/scope";
import { overlayEventsUrl } from "./threadLive";

export const OVERLAY_POLL_MS = 2000;
const SLOW_RETRY_MS = 60_000;

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
 *  from that scope (fresh token), never from the active server. */
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
    if (stopped || wsTimer) return;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (stopped) return;
    let url: string | null = null;
    try {
      url = overlayEventsUrl(opts.scope.httpBase(), opts.scope.token(), opts.conversationId);
    } catch {
      url = null; // ServerRemovedError: poll answers "removed" from its own scope
    }
    if (!url) {
      startPoll();
      return;
    }
    let opened = false;
    try {
      ws = new WebSocket(url);
    } catch {
      handshakeFails += 1;
      if (handshakeFails >= 2) startPoll();
      schedule(
        handshakeFails >= 2
          ? SLOW_RETRY_MS
          : Math.min(30_000, 1000 * 2 ** handshakeFails)
      );
      return;
    }
    const sock = ws;
    sock.onopen = () => {
      if (stopped || ws !== sock) return;
      opened = true;
      handshakeFails = 0;
      reconnectAttempt = 0;
      const catchUp = everOpened || !!pollTimer;
      stopPoll();
      everOpened = true;
      if (catchUp) opts.onNeedCatchUp();
      // A (re)opened socket is a new viewer on the daemon: say so now.
      if (viewing) startViewing();
      opts.onOpen?.();
    };
    sock.onmessage = (e) => {
      if (stopped || ws !== sock) return;
      try {
        opts.onItem(JSON.parse(String(e.data)) as ThreadItem);
      } catch {
        /* non-JSON */
      }
    };
    sock.onclose = () => {
      if (stopped || ws !== sock) return;
      ws = null;
      if (!opened) {
        handshakeFails += 1;
        if (handshakeFails >= 2) {
          startPoll();
          schedule(SLOW_RETRY_MS);
          return;
        }
        schedule(Math.min(30_000, 1000 * 2 ** handshakeFails));
        return;
      }
      schedule(Math.min(30_000, 1000 * 2 ** reconnectAttempt++));
    };
    sock.onerror = () => {
      sock.close();
    };
  }

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
      stopPoll();
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
