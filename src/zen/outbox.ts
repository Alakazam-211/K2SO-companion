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
  /** `queued`: typed while its server was down; goes out on its own once
   *  the server is back (auto reconnect, `sendQueue.ts`). */
  status: "sending" | "failed" | "queued";
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

/** The server message this send became, once it shows up in the thread
 *  (POST answer, socket echo or a re-read): by server id when known, else
 *  a new message of mine with the same body. Null = not landed yet. */
export function landedId(o: OutgoingMessage, thread: ThreadMessage[]): string | null {
  if (o.serverId && thread.some((m) => m.id === o.serverId)) return o.serverId;
  const body = (o.body || "").trim();
  if (!body) return null;
  const before = new Set(o.beforeIds);
  const hit = thread.find(
    (m) => m.mine && !before.has(m.id) && (m.text || "").trim() === body
  );
  return hit ? hit.id : null;
}

/** Has this send already shown up in the server's thread? */
export function hasLanded(o: OutgoingMessage, thread: ThreadMessage[]): boolean {
  return landedId(o, thread) != null;
}

/** `landedKeys` key: a server message id within its room. */
export function landedKey(roomKey: string, messageId: string): string {
  return `${roomKey}\n${messageId}`;
}

/** How many landed sends keep their row key (only the recent ones matter:
 *  the swap happens once, right after Send). */
export const LANDED_KEYS_MAX = 64;

/** Remember that `messageId` in `roomKey` is the send `localId`, so its row
 *  keeps the optimistic bubble's React key (and DOM node) after the
 *  outbox entry is gone. Oldest entries fall off past the cap. */
export function rememberLanded(
  keys: Record<string, string>,
  roomKey: string,
  messageId: string | null | undefined,
  localId: string
): Record<string, string> {
  if (!messageId) return keys;
  const k = landedKey(roomKey, messageId);
  if (keys[k] === localId) return keys;
  const entries = Object.entries(keys).filter(([key]) => key !== k);
  entries.push([k, localId]);
  return Object.fromEntries(entries.slice(-LANDED_KEYS_MAX));
}

/** Row keys for the thread's messages that began as a send in this room:
 *  server id → the send's `localId`. Covers an echo that landed while its
 *  outbox entry is still there and one whose entry was already dropped
 *  (`landed`). A send's bubble is then one element from tap to delivered:
 *  no remount, never two of it, never none. */
export function landedRowKeys(
  outbox: OutgoingMessage[],
  thread: ThreadMessage[],
  roomKey: string,
  landed: Record<string, string>
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const m of thread) {
    const local = m.id ? landed[landedKey(roomKey, m.id)] : undefined;
    if (local) keys.set(m.id, local);
  }
  for (const o of outbox) {
    if (o.roomKey !== roomKey) continue;
    const id = landedId(o, thread);
    if (id) keys.set(id, o.localId);
  }
  return keys;
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
    pending: o.status === "sending" || o.status === "queued",
    failed: o.status === "failed",
  };
}
