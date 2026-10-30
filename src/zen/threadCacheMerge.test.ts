import { describe, expect, it } from "vitest";
import {
  cacheSlice,
  mergeDelta,
  mergeGroupDelta,
  mergeServerPage,
  newestSeq,
  shareUnchanged,
} from "./threadCacheMerge";
import type { ThreadMessage } from "./threadModel";

function msg(seq: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `m${seq}`,
    seq,
    text: `text ${seq}`,
    from: "agent",
    at: seq,
    mine: false,
    kind: "text",
    choice: null,
    ...over,
  };
}
const ids = (t: ThreadMessage[]) => t.map((m) => m.id);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));

describe("mergeServerPage", () => {
  it("the server copy wins for overlapping messages (an answered card)", () => {
    const card = msg(3, { choice: { prompt: "Ok?", options: ["Yes", "No"], answer: null } });
    const cached = [msg(1), msg(2), card];
    const answered = msg(3, { choice: { prompt: "Ok?", options: ["Yes", "No"], answer: "Yes" } });
    const out = mergeServerPage(cached, [msg(1), msg(2), answered], { hasMore: false });
    expect(out[2].choice?.answer).toBe("Yes");
    // Unchanged messages keep their objects.
    expect(out[0]).toBe(cached[0]);
    expect(out[1]).toBe(cached[1]);
  });

  it("an unchanged page keeps the very same array (no re-render)", () => {
    const cached = range(1, 5);
    const page = range(1, 5).map((m) => ({ ...m }));
    expect(mergeServerPage(cached, page, { hasMore: false })).toBe(cached);
  });

  it("drops cached messages the page proves gone inside its window only", () => {
    // Cache: 1..10; the server's newest page covers 6..10 without 8, and
    // has older messages.
    const cached = range(1, 10);
    const page = [msg(6), msg(7), msg(9), msg(10)];
    const out = mergeServerPage(cached, page, { hasMore: true });
    expect(ids(out)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m9", "m10"]);
  });

  it("without more history, cached messages older than the page are gone too", () => {
    const out = mergeServerPage(range(1, 10), [msg(6), msg(7)], { hasMore: false });
    expect(ids(out)).toEqual(["m6", "m7"]);
  });

  it("new server messages are appended in seq order", () => {
    const out = mergeServerPage(range(1, 3), range(2, 6), { hasMore: true });
    expect(ids(out)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("cached messages newer than the page are gone, unless a live frame brought them meanwhile", () => {
    const cached = [...range(1, 4), msg(5), msg(6)];
    const page = range(1, 4);
    expect(ids(mergeServerPage(cached, page, { hasMore: false }))).toEqual(["m1", "m2", "m3", "m4"]);
    const live = new Set(["m6"]);
    expect(ids(mergeServerPage(cached, page, { hasMore: false, arrivedLive: live }))).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m6",
    ]);
  });

  it("keeps the phone's pending and failed sends", () => {
    const pending = msg(99, { id: "local-1", seq: null, pending: true, mine: true });
    const failed = msg(98, { id: "local-2", seq: null, failed: true, mine: true });
    const out = mergeServerPage([msg(1), pending, failed], [msg(1), msg(2)], { hasMore: false });
    expect(ids(out)).toEqual(["m1", "m2", "local-1", "local-2"]);
  });

  it("another conversation replaces the cached copy whole", () => {
    const out = mergeServerPage(range(10, 20), [msg(1), msg(2)], {
      hasMore: true,
      sameConversation: false,
    });
    expect(ids(out)).toEqual(["m1", "m2"]);
  });

  it("an empty page empties the Thread", () => {
    expect(mergeServerPage(range(1, 3), [], { hasMore: false })).toEqual([]);
  });

  it("file states from the server replace the cached ones", () => {
    const file = { n: 0, kind: "file", path: "a.txt", name: "a.txt", size: 1, mime: "text/plain", modifiedAt: null, sha256: null, line: null, lineEnd: null };
    const cached = [msg(1, { files: [{ ...file, state: "ok" as const }] })];
    const out = mergeServerPage(cached, [msg(1, { files: [{ ...file, state: "gone" as const }] })], { hasMore: false });
    expect(out[0].files?.[0].state).toBe("gone");
  });
});

describe("mergeDelta", () => {
  it("appends new messages and replaces changed older ones by id", () => {
    const cached = range(1, 3);
    const changed = msg(2, { text: "edited" });
    const out = mergeDelta(cached, [changed, msg(4), msg(5)]);
    expect(ids(out)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(out[1].text).toBe("edited");
    expect(out[0]).toBe(cached[0]);
  });

  it("an empty delta changes nothing", () => {
    const cached = range(1, 3);
    expect(mergeDelta(cached, [])).toBe(cached);
  });
});

describe("mergeGroupDelta", () => {
  it("orders project lines by their own seq and renumbers positions", () => {
    const cached: ThreadMessage[] = [
      msg(0, { id: "a", readSeq: 10 }),
      msg(1, { id: "b", readSeq: 11 }),
    ];
    const out = mergeGroupDelta(cached, [msg(0, { id: "c", readSeq: 12 }), msg(0, { id: "b", readSeq: 11, text: "B" })]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
    expect(out.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(out[1].text).toBe("B");
    expect(out[0]).toBe(cached[0]);
  });
});

describe("cacheSlice / newestSeq / shareUnchanged", () => {
  it("keeps the newest N settled messages and says when it cut", () => {
    const thread = [...range(1, 120), msg(0, { id: "p", seq: null, pending: true })];
    const s = cacheSlice(thread, 100);
    expect(s.truncated).toBe(true);
    expect(s.messages).toHaveLength(100);
    expect(s.messages[0].id).toBe("m21");
    expect(s.messages.some((m) => m.pending)).toBe(false);
    expect(cacheSlice(range(1, 5), 100).truncated).toBe(false);
  });

  it("newestSeq skips pending rows; readSeq for project chats", () => {
    expect(newestSeq([msg(1), msg(7), msg(9, { pending: true })])).toBe(7);
    expect(newestSeq([msg(0, { readSeq: 40 }), msg(1, { readSeq: 41 })], "readSeq")).toBe(41);
    expect(newestSeq([])).toBeNull();
  });

  it("shareUnchanged returns prev when equal", () => {
    const a = range(1, 3);
    expect(shareUnchanged(a, a.map((m) => ({ ...m })))).toBe(a);
  });
});

describe("messages from a push (provisional)", () => {
  it("never move the delta cursor: a gap before one is still fetched", () => {
    // Cached to 10; a push brought 12 (11 came with no alert).
    const held = [msg(9), msg(10), msg(12, { provisional: true })];
    expect(newestSeq(held)).toBe(10);
    // The delta after 10 brings 11 and the confirmed 12.
    const merged = mergeDelta(held, [msg(11), msg(12)]);
    expect(ids(merged)).toEqual(["m9", "m10", "m11", "m12"]);
    expect(merged[3].provisional).toBeUndefined();
    expect(newestSeq(merged)).toBe(12);
  });

  it("the server's copy replaces a partial one, even with the same text", () => {
    const held = [msg(1), msg(2, { provisional: true, partial: true, text: "text 2" })];
    const merged = mergeDelta(held, [msg(2)]);
    expect(merged[1]).not.toBe(held[1]);
    expect(merged[1]).toMatchObject({ id: "m2", text: "text 2" });
    expect(merged[1].partial).toBeUndefined();
    expect(merged[1].provisional).toBeUndefined();
  });

  it("a newest page replaces it inside its window", () => {
    const held = [msg(1), msg(2, { provisional: true, partial: true, text: "te" })];
    const merged = mergeServerPage(held, [msg(1), msg(2)], { hasMore: false });
    expect(merged[1]).toMatchObject({ text: "text 2" });
    expect(merged[1].provisional).toBeUndefined();
  });
});
