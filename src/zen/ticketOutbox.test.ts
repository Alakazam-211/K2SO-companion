import { describe, expect, it } from "vitest";
import type { FeedbackComment } from "../api/feedbackPure";
import { landedKey } from "./outbox";
import {
  commentInFlight,
  commentLandedIndex,
  commentRowId,
  ticketRoomKey,
  ticketRows,
  type OutgoingComment,
} from "./ticketOutbox";

const ROOM = ticketRoomKey("s1", "t1");
const mine = (a: string) => a === "u";
const c = (author: string, body: string, at = 100): FeedbackComment => ({ author, body, at });
const out = (localId: string, text: string, beforeCount: number, over: Partial<OutgoingComment> = {}): OutgoingComment => ({
  localId,
  roomKey: ROOM,
  text,
  at: 200,
  beforeCount,
  status: "sending",
  error: null,
  author: null,
  ...over,
});

describe("ticketOutbox", () => {
  it("room keys are per server and ticket, apart from the Thread's", () => {
    expect(ticketRoomKey("s1", "t1")).toBe("s1|ticket:t1");
    expect(ticketRoomKey("s2", "t1")).not.toBe(ROOM);
  });

  it("lands on the first new comment of mine with the same body, never an older one", () => {
    const comments = [c("u", "ok"), c("sales", "ok"), c("u", "ok", 300)];
    expect(commentLandedIndex(out("a", "ok", 1), comments, mine)).toBe(2);
    expect(commentLandedIndex(out("a", "ok", 3), comments, mine)).toBeNull();
    // The author the server gave it counts as mine too.
    expect(commentLandedIndex(out("a", "ok", 1, { author: "sales" }), comments, () => false)).toBe(1);
  });

  it("two sends with the same text land on two comments, one row each", () => {
    const comments = [c("u", "ok", 1), c("u", "ok", 2)];
    const { keys, visible, landedNow } = ticketRows(
      [out("a", "ok", 0), out("b", "ok", 0)],
      comments,
      ROOM,
      {},
      mine
    );
    expect([...keys.entries()]).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    expect(visible).toEqual([]);
    expect(landedNow.map((l) => l.rowId)).toEqual([commentRowId(comments[0], 0), commentRowId(comments[1], 1)]);
  });

  it("a remembered landing keeps its key after the outbox entry is gone; other rooms are ignored", () => {
    const comments = [c("sales", "hi"), c("u", "ok")];
    const landed = { [landedKey(ROOM, commentRowId(comments[1], 1))]: "a" };
    const other = out("z", "ok", 0, { roomKey: ticketRoomKey("s1", "t2") });
    const { keys, visible } = ticketRows([other], comments, ROOM, landed, mine);
    expect(keys.get(1)).toBe("a");
    expect(keys.has(0)).toBe(false);
    expect(visible).toEqual([]);
  });

  it("not landed yet: drawn as an optimistic row; in flight only while sending in this room", () => {
    const o = out("a", "new", 1);
    const { visible } = ticketRows([o], [c("u", "old")], ROOM, {}, mine);
    expect(visible).toEqual([o]);
    expect(commentInFlight([o], ROOM)).toBe(true);
    expect(commentInFlight([{ ...o, status: "failed" }], ROOM)).toBe(false);
    expect(commentInFlight([o], ticketRoomKey("s1", "t2"))).toBe(false);
  });
});
