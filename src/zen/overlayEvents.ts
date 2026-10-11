import { getBaseUrl, getToken, type ThreadItem } from "../api/client";
import { overlayEventsUrl } from "./threadLive";

export const OVERLAY_POLL_MS = 2000;
const SLOW_RETRY_MS = 60_000;

export type OverlayLiveHandle = { stop: () => void };

/** Skin live path: WS `/cli/overlay/events?conversation=`. Token query
 *  because WebSocket cannot set Authorization. After two handshake
 *  failures, poll GET every 2s and retry the socket once a minute. */
export function connectOverlayEvents(opts: {
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
    const url = overlayEventsUrl(
      getBaseUrl(),
      getToken(),
      opts.conversationId
    );
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
    stop() {
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
