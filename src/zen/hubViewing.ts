import type { ThreadItem } from "../api/client";
import type { ServerScope } from "../api/scope";
import { connectOverlayEvents, type OverlayLiveHandle } from "./overlayEvents";
import { hubSend, onHubOpen, subscribeAppEvents } from "./ticketEvents";

// The open Thread on the server's one hub socket (K2 0.46.8
// `hub-viewing-v1`, agreed contract in the speed PRD): no overlay socket,
// so one socket per server with a chat open.
//
//   client → {"t":"viewing","conversationId","visible"}   (one view per socket)
//   daemon → {"kind":"viewing_ok","conversation_id","rev","convRev","instanceId","turn"}
//            then, for that chat only: thread_message / thread_moved /
//            thread_address (frames at or below viewing_ok.rev are skipped),
//            thread_activity (the overlay's activity frame) and
//            thread_activity_reset {turn} after a lag;
//            a second viewing_ok with reason:"lagged" when its feed lagged;
//            viewing_error {code} when refused (the view is gone).
//
// The view lasts 90 s unless re-sent (every 60 s here) and ends with the
// socket. On every viewing_ok: skip the catch-up read when the daemon is
// the same (`instanceId`) and nothing moved in this chat since we were last
// current (`convRev` <= the rev we last had); seed the working strip from
// `turn` (no /cli/thread/activity read). A refusal falls back to the
// overlay socket for this chat.

export const FEATURE_HUB_VIEWING = "hub-viewing-v1";
export const VIEWING_RESEND_MS = 60_000;

type Mark = { instanceId: string | null; rev: number };
/** `${serverId}|${conversationId}` → how current this phone was. */
const marks = new Map<string, Mark>();

const HUB_KINDS = new Set([
  "viewing_ok",
  "viewing_error",
  "thread_message",
  "thread_moved",
  "thread_address",
  "thread_activity",
  "thread_activity_reset",
]);

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function connectHubViewing(opts: {
  scope: ServerScope;
  conversationId: string;
  onItem: (raw: ThreadItem) => void;
  onNeedCatchUp: () => void;
  onOpen?: () => void;
  /** The current turn (viewing_ok, thread_activity_reset): `{turn}` as
   *  `/cli/thread/activity` answers. */
  onTurn?: (data: { turn: unknown }) => void;
}): OverlayLiveHandle {
  const serverId = opts.scope.id;
  let conv = opts.conversationId;
  let visible = false;
  let stopped = false;
  let fallback: OverlayLiveHandle | null = null;
  let resend: ReturnType<typeof setInterval> | null = null;
  const key = () => `${serverId}|${conv}`;

  const send = (on: boolean) => hubSend(serverId, { t: "viewing", conversationId: conv, visible: on });
  const startResend = () => {
    if (resend) return;
    resend = setInterval(() => {
      if (!stopped && visible && !fallback) send(true);
    }, VIEWING_RESEND_MS);
  };
  const stopResend = () => {
    if (resend) clearInterval(resend);
    resend = null;
  };

  const noteRev = (rev: number | null) => {
    if (rev == null) return;
    const m = marks.get(key());
    if (m && rev > m.rev) marks.set(key(), { ...m, rev });
  };

  const onFrame = (raw: unknown) => {
    const f = obj(raw);
    if (!f || stopped || fallback) return;
    const kind = f.kind;
    if (kind === "thread_moved") {
      if (f.from !== conv) return;
      // The view follows the move (the daemon moves it too).
      if (typeof f.to === "string" && f.to) conv = f.to;
      opts.onNeedCatchUp();
      return;
    }
    if (f.conversation_id !== conv) return;
    switch (kind) {
      case "viewing_ok": {
        const inst = typeof f.instanceId === "string" ? f.instanceId : null;
        const rev = num(f.rev) ?? 0;
        const convRev = num(f.convRev);
        const prev = marks.get(key());
        const current = !!prev && prev.instanceId === inst && convRev != null && convRev <= prev.rev;
        marks.set(key(), { instanceId: inst, rev });
        // A first view (no mark) rides the open's own read; afterwards,
        // read only when this chat moved past what we had.
        if (prev && !current) opts.onNeedCatchUp();
        if ("turn" in f) opts.onTurn?.({ turn: f.turn });
        return;
      }
      case "viewing_error": {
        // Refused (the view is gone): this chat on its own socket.
        stopResend();
        fallback = connectOverlayEvents(opts);
        if (visible) fallback.setViewing(true);
        return;
      }
      case "thread_message": {
        // Cut short at 32 KiB: provisional; read the chat whole.
        if (f.truncated === true || !f.doc) {
          opts.onNeedCatchUp();
        } else {
          opts.onItem(f as unknown as ThreadItem);
        }
        noteRev(num(f.rev));
        return;
      }
      case "thread_address":
        noteRev(num(f.rev));
        opts.onNeedCatchUp();
        return;
      case "thread_activity":
        opts.onItem(f as unknown as ThreadItem);
        return;
      case "thread_activity_reset":
        opts.onTurn?.({ turn: f.turn ?? null });
        return;
    }
  };

  const sub = subscribeAppEvents(
    opts.scope,
    (frame) => HUB_KINDS.has(String(obj(frame)?.kind ?? "")),
    () => {},
    onFrame
  );
  // Every hub (re)open: the view is gone with the old socket; ask again.
  const offOpen = onHubOpen((id) => {
    if (id !== serverId || stopped || fallback) return;
    if (visible) send(true);
  });

  return {
    stop() {
      if (stopped) return;
      if (visible && !fallback) send(false);
      stopped = true;
      stopResend();
      sub.stop();
      offOpen();
      fallback?.stop();
    },
    setViewing(on: boolean) {
      if (stopped) return;
      if (fallback) {
        fallback.setViewing(on);
        visible = on;
        return;
      }
      if (on === visible) return;
      visible = on;
      if (on) {
        send(true);
        startResend();
      } else {
        send(false);
        stopResend();
      }
    },
  };
}

export function __resetHubViewingForTests(): void {
  marks.clear();
}
