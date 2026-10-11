import type { ThreadMessage } from "./threadModel";

/** A Thread send the user tapped but the server has not confirmed yet
 *  (iMessage-style optimistic bubble). Lives beside `thread`, never in
 *  it: `thread` stays server truth, so a re-read or a socket echo cannot
 *  drop or double it. A failed one stays until it is retried, put back
 *  into the composer, or lands after all. */
export type OutgoingMessage = {
  /** Temp id (`local-…`); never a server id. */
  localId: string;
  /** The room it was typed in (`threadRoomKey`). Shown only there. */
  roomKey: string;
  /** What was typed (the caption when files ride along). */
  text: string;
  /** Files picked with it, kept for retry and for putting back. */
  files: File[];
  /** Uploaded path per file (index-aligned); null = not uploaded yet. */
  paths: (string | null)[];
  attachWorkspace: string | null;
  attachDir: string | null;
  status: "sending" | "failed";
  error: string | null;
  /** Unix seconds when Send was tapped. */
  at: number;
  /** Thread ids on screen when Send was tapped: an echo is a NEW id. */
  beforeIds: string[];
  /** The body actually POSTed (caption + paths), once known. */
  body: string | null;
  /** The server's id for it, once the POST answered. */
  serverId: string | null;
};

/** The room an outgoing message belongs to: server + project group or addr. */
export function threadRoomKey(
  serverId: string | null | undefined,
  groupId: string | null | undefined,
  addr: string | null | undefined
): string {
  const g = (groupId || "").trim();
  return `${serverId || ""}|${g ? `g:${g}` : `t:${(addr || "").trim()}`}`;
}

let nextLocal = 0;
export function newLocalId(): string {
  nextLocal += 1;
  return `local-${Date.now().toString(36)}-${nextLocal}`;
}

/** Has this send already shown up in the server's thread (POST answer,
 *  socket echo or a re-read)? By server id when known, else a new
 *  message of mine with the same body. */
export function hasLanded(o: OutgoingMessage, thread: ThreadMessage[]): boolean {
  if (o.serverId && thread.some((m) => m.id === o.serverId)) return true;
  const body = (o.body || "").trim();
  if (!body) return false;
  const before = new Set(o.beforeIds);
  return thread.some(
    (m) => m.mine && !before.has(m.id) && (m.text || "").trim() === body
  );
}

/** The optimistic bubbles to draw in this room: its own, minus any the
 *  thread already shows (so a send is exactly one bubble). */
export function visibleOutgoing(
  outbox: OutgoingMessage[],
  thread: ThreadMessage[],
  roomKey: string
): OutgoingMessage[] {
  return outbox.filter((o) => o.roomKey === roomKey && !hasLanded(o, thread));
}

/** A send in flight in this room (the double-send guard). */
export function sendInFlight(
  outbox: OutgoingMessage[],
  thread: ThreadMessage[],
  roomKey: string
): boolean {
  return visibleOutgoing(outbox, thread, roomKey).some((o) => o.status === "sending");
}

/** The bubble shape for an outgoing message. */
export function outgoingBubble(o: OutgoingMessage): ThreadMessage {
  return {
    id: o.localId,
    seq: null,
    text: o.text,
    from: "owner",
    at: o.at,
    mine: true,
    kind: "text",
    choice: null,
    pending: o.status === "sending",
    failed: o.status === "failed",
  };
}
