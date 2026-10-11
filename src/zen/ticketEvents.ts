import { getBaseUrl, getToken } from "../api/client";
import { isTicketEventFrame } from "../api/feedbackPure";

// Live ticket changes for the Zen Tickets overlay: WS
// `/cli/sessions/events?path=&token=` (empty path = every app-level
// event). Ticket frames — `feedback_changed` and `ticket_changed`
// (0.43.3+) — carry ids only, so each burst debounces into ONE refetch
// (300 ms, the desktop board's window). The overlay also polls, so a
// socket that never opens costs nothing but the poll.
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

export function connectTicketEvents(onChange: () => void): TicketEventsHandle {
  let stopped = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let everOpened = false;
  let instanceId: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const bump = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped) onChange();
    }, TICKET_EVENT_DEBOUNCE_MS);
  };

  const schedule = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  };

  function open() {
    if (stopped) return;
    const url = ticketEventsUrl(getBaseUrl(), getToken() ?? "");
    if (!url) return; // not connected: the poll carries the overlay
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (stopped || ws !== sock) return;
      attempt = 0;
      // A re-open may have missed frames while down: re-pull once.
      if (everOpened) bump();
      everOpened = true;
    };
    sock.onmessage = (e) => {
      if (stopped || ws !== sock) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "hello") {
        const id = (frame as { instance_id?: unknown }).instance_id;
        const next = typeof id === "string" ? id : null;
        if (instanceId && next && next !== instanceId) bump();
        if (next) instanceId = next;
        return;
      }
      if (isTicketEventFrame(frame)) bump();
    };
    sock.onclose = (e) => {
      if (stopped || ws !== sock) return;
      ws = null;
      if (e.code === 4001) {
        stopped = true; // revoked / refused token: never reconnect
        return;
      }
      schedule();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* */
      }
    };
  }

  open();
  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (debounce) clearTimeout(debounce);
      retryTimer = null;
      debounce = null;
      try {
        ws?.close();
      } catch {
        /* */
      }
      ws = null;
    },
  };
}
