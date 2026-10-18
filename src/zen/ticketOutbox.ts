import type { FeedbackComment } from "../api/feedbackPure";
import { landedKey } from "./outbox";

// A ticket comment the user sent but the server has not shown back yet:
// the Thread outbox (`outbox.ts`) for a ticket's comments. It lives beside
// `openItem.comments`, never in it, so a refetch cannot drop or double it.
// Comments carry no id on the wire (`show` → {author, body, at}), so a send
// lands on the first new comment of mine with the same body; its row then
// keeps the send's `localId` as its React key (one element from tap to
// delivered), remembered in `landedKeys` once the entry is dropped.

export type OutgoingComment = {
  /** Temp id (`newLocalId()`); the row's React key for good. */
  localId: string;
  /** `ticketRoomKey(server, ticket)`: shown only on that ticket. */
  roomKey: string;
  /** The trimmed body POSTed. */
  text: string;
  /** Unix seconds when Send was tapped. */
  at: number;
  /** Comments on screen at Send: the server's copy comes after these. */
  beforeCount: number;
  /** `sent` = the POST answered ok; the refetch has not shown it yet. */
  status: "sending" | "sent" | "failed";
  error: string | null;
  /** The author the server recorded (`CommentResponse.author`), once known. */
  author: string | null;
};

/** The ticket an outgoing comment belongs to: server + ticket id. Distinct
 *  from the Thread rooms (`|t:` / `|g:`), so a draft key cannot collide. */
export function ticketRoomKey(
  serverId: string | null | undefined,
  ticketId: string | null | undefined
): string {
  return `${serverId || ""}|ticket:${(ticketId || "").trim()}`;
}

/** A server comment's row id: comments only ever append, so its index
 *  (with its time, against a reorder) names it for the ticket's life. */
export function commentRowId(c: FeedbackComment, index: number): string {
  return `${index}:${c.at}`;
}

/** Where this send shows up in the ticket's comments: the first comment
 *  after `beforeCount` by me (or the author the server gave it) with the
 *  same body that no other send claimed. Null = not landed yet. */
export function commentLandedIndex(
  o: OutgoingComment,
  comments: FeedbackComment[],
  isMine: (author: string) => boolean,
  claimed: ReadonlySet<number> = new Set()
): number | null {
  const body = o.text.trim();
  if (!body) return null;
  for (let i = Math.max(0, o.beforeCount); i < comments.length; i++) {
    if (claimed.has(i)) continue;
    const c = comments[i];
    const mine = (o.author != null && c.author === o.author) || isMine(c.author);
    if (mine && (c.body || "").trim() === body) return i;
  }
  return null;
}

/** The ticket's rows: comment index → the send's `localId` for comments
 *  that began as a send here (remembered or still in the outbox), and the
 *  sends still to draw as optimistic bubbles after them. A send is
 *  exactly one row: never two of it, never none. */
export function ticketRows(
  outbox: OutgoingComment[],
  comments: FeedbackComment[],
  roomKey: string,
  landed: Record<string, string>,
  isMine: (author: string) => boolean
): { keys: Map<number, string>; landedNow: Array<{ localId: string; rowId: string }>; visible: OutgoingComment[] } {
  const keys = new Map<number, string>();
  const used = new Set<string>();
  comments.forEach((c, i) => {
    const local = landed[landedKey(roomKey, commentRowId(c, i))];
    if (local) {
      keys.set(i, local);
      used.add(local);
    }
  });
  const claimed = new Set(keys.keys());
  const landedNow: Array<{ localId: string; rowId: string }> = [];
  const visible: OutgoingComment[] = [];
  for (const o of outbox) {
    if (o.roomKey !== roomKey || used.has(o.localId)) continue;
    const i = commentLandedIndex(o, comments, isMine, claimed);
    if (i == null) {
      visible.push(o);
      continue;
    }
    claimed.add(i);
    keys.set(i, o.localId);
    landedNow.push({ localId: o.localId, rowId: commentRowId(comments[i], i) });
  }
  return { keys, landedNow, visible };
}

/** A comment of this ticket still being POSTed (the double-send guard). */
export function commentInFlight(outbox: OutgoingComment[], roomKey: string): boolean {
  return outbox.some((o) => o.roomKey === roomKey && o.status === "sending");
}
