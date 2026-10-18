import { describe, expect, it, vi } from "vitest";
import type { ThreadItem } from "../api/client";
import type { ProjectGroupMessage } from "../api/projectGroups";
import { fakeScope } from "../test/fakeScope";
import {
  applyGroupRead,
  applyThreadRead,
  fetchGroupRead,
  fetchThreadRead,
  type CacheBase,
  type ChatRead,
  type ReadDeps,
} from "./chatRevalidate";
import type { ThreadMessage } from "./threadModel";

const withDelta = () => fakeScope({ id: "s1", features: ["thread-delta-v1"] });
const noDelta = () => fakeScope({ id: "s1" });

function item(seq: number, body = `m${seq}`, doc: Record<string, unknown> = {}): ThreadItem {
  return { id: `m${seq}`, seq, doc: { from: "agent", body, created_at: seq, ...doc } } as ThreadItem;
}
function msg(seq: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id: `m${seq}`, seq, text: `m${seq}`, from: "agent", at: seq, mine: false, kind: "text", choice: null, ...over };
}
const card = (seq: number, answer: string | null) =>
  item(seq, "", { kind: "choice", choice: { prompt: "Ship?", options: ["Ship", "Hold"], answer } });
const cachedCard = (seq: number) =>
  msg(seq, { text: "", kind: "choice", choice: { prompt: "Ship?", options: ["Ship", "Hold"], answer: null } });

function deps(over: Partial<ReadDeps> = {}): ReadDeps {
  return {
    getThread: vi.fn(async () => ({ ok: true, data: { conversation_id: "c1", items: [item(60), item(61)], has_more: true } })) as never,
    fetchThreadDelta: vi.fn(async () => ({
      ok: true,
      data: { items: [], changed: [], removed: [], hasMore: false, conversationId: "c1", bytes: 2 },
    })) as never,
    fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })) as never,
    fetchProjectGroupDelta: vi.fn(async () => ({
      ok: true,
      data: { items: [], changed: [], removed: [], hasMore: false, conversationId: null, bytes: 2 },
    })) as never,
    ...over,
  };
}
const ok = (r: ChatRead) => {
  if (!r.ok) throw new Error(`read failed: ${r.error}`);
  return r;
};
const ids = (t: ThreadMessage[]) => t.map((m) => m.id);

describe("Thread revalidation (thread-delta-v1)", () => {
  it("asks after the highest cached seq and applies removed, then changed, then items", async () => {
    const d = deps({
      fetchThreadDelta: vi.fn(async () => ({
        ok: true,
        data: {
          items: [item(4)],
          changed: [card(3, "Ship"), item(5, "re-sent")],
          removed: [{ id: "m2", seq: 2 }, { id: "m5", seq: 5 }],
          hasMore: false,
          conversationId: "c1",
          bytes: 9,
        },
      })) as never,
    });
    const cached = [msg(1), msg(2), cachedCard(3), msg(5)];
    const r = ok(await fetchThreadRead(withDelta(), "sales", { messages: cached, conversationId: "c1" }, d));
    expect(d.fetchThreadDelta).toHaveBeenCalledWith(expect.anything(), "sales", 5, 50);
    expect(d.getThread).not.toHaveBeenCalled();
    expect(r.mode).toBe("delta");
    expect(r.counts).toEqual({ items: 1, changed: 2, removed: 2, pages: 1 });
    const out = applyThreadRead(cached, r);
    // m2 removed; m5 removed THEN upserted by `changed` (order matters);
    // the card answered in place; m4 appended.
    expect(ids(out)).toEqual(["m1", "m3", "m4", "m5"]);
    expect(out[1].choice?.answer).toBe("Ship");
    expect(out[3].text).toBe("re-sent");
    expect(out[0]).toBe(cached[0]);
  });

  it("has_more: pages forward from the last item's seq, applying every page's changed / removed", async () => {
    const fetchThreadDelta = vi.fn(async (_s: unknown, _a: string, after: number) => ({
      ok: true,
      data:
        after === 10
          ? { items: [item(11), item(12)], changed: [card(3, "Hold")], removed: [{ id: "m1", seq: 1 }], hasMore: true, conversationId: "c1", bytes: 9 }
          : { items: [item(13)], changed: [card(3, "Hold")], removed: [{ id: "m1", seq: 1 }], hasMore: false, conversationId: "c1", bytes: 4 },
    }));
    const d = deps({ fetchThreadDelta: fetchThreadDelta as never });
    const cached = [msg(1), msg(2), cachedCard(3), msg(10)];
    const r = ok(await fetchThreadRead(withDelta(), "sales", { messages: cached, conversationId: "c1" }, d));
    expect(fetchThreadDelta.mock.calls.map((c) => c[2])).toEqual([10, 12]);
    expect(d.getThread).not.toHaveBeenCalled();
    expect(r.mode).toBe("delta");
    expect(r.counts).toEqual({ items: 3, changed: 2, removed: 2, pages: 2 });
    const out = applyThreadRead(cached, r);
    expect(ids(out)).toEqual(["m2", "m3", "m10", "m11", "m12", "m13"]);
    expect(out[1].choice?.answer).toBe("Hold");
  });

  it("still more after four pages: the newest page replaces the copy (no hole)", async () => {
    const fetchThreadDelta = vi.fn(async (_s: unknown, _a: string, after: number) => ({
      ok: true,
      data: { items: [item(after + 1), item(after + 2)], changed: [], removed: [], hasMore: true, conversationId: "c1", bytes: 1 },
    }));
    const d = deps({
      fetchThreadDelta: fetchThreadDelta as never,
      getThread: vi.fn(async () => ({ ok: true, data: { conversation_id: "c1", items: [item(60), item(61)], has_more: true } })) as never,
    });
    const pending = msg(0, { id: "local", seq: null, pending: true });
    const cached = [msg(1), msg(10)];
    const r = ok(await fetchThreadRead(withDelta(), "sales", { messages: cached, conversationId: "c1" }, d));
    expect(fetchThreadDelta.mock.calls.map((c) => c[2])).toEqual([10, 12, 14, 16]);
    expect(vi.mocked(d.getThread).mock.calls[0]).toHaveLength(2); // the newest page: no cursor
    expect(r.mode).toBe("replace");
    expect(r.hasMore).toBe(true); // Load earlier pages back from m60
    const live = new Set(["m99"]);
    const out = applyThreadRead([...cached, msg(99), pending], r, { arrivedLive: live });
    expect(ids(out)).toEqual(["m60", "m61", "m99", "local"]);
  });

  it("another conversation id: the copy is dropped for the newest page", async () => {
    const d = deps({
      fetchThreadDelta: vi.fn(async () => ({
        ok: true,
        data: { items: [item(1)], changed: [], removed: [], hasMore: false, conversationId: "c2", bytes: 1 },
      })) as never,
      getThread: vi.fn(async () => ({ ok: true, data: { conversation_id: "c2", items: [item(1, "new"), item(2)], has_more: false } })) as never,
    });
    const cached = [msg(1), msg(40), msg(41)];
    const r = ok(await fetchThreadRead(withDelta(), "sales", { messages: cached, conversationId: "c1" }, d));
    expect(r.mode).toBe("reset");
    expect(r.conversationId).toBe("c2");
    const out = applyThreadRead(cached, r, { conversationId: "c1" });
    expect(ids(out)).toEqual(["m1", "m2"]);
    expect(out[0].text).toBe("new");
  });

  it("403 / 404 mean gone; an unreachable server is an error; a refused delta falls back to the page", async () => {
    const base = { messages: [msg(1)], conversationId: "c1" };
    for (const status of [403, 404]) {
      const d = deps({ fetchThreadDelta: vi.fn(async () => ({ ok: false, status, error: "nope" })) as never });
      const r = await fetchThreadRead(withDelta(), "a", base, d);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.gone).toBe(true);
      expect(d.getThread).not.toHaveBeenCalled();
    }
    const down = deps({ fetchThreadDelta: vi.fn(async () => ({ ok: false, error: "Could not reach server: x" })) as never });
    const r1 = await fetchThreadRead(withDelta(), "a", base, down);
    expect(!r1.ok && r1.gone).toBe(false);
    expect(down.getThread).not.toHaveBeenCalled();
    const usage = deps({ fetchThreadDelta: vi.fn(async () => ({ ok: false, status: 400, error: "usage" })) as never });
    expect(ok(await fetchThreadRead(withDelta(), "a", base, usage)).mode).toBe("page");
    // A full read's 404 is gone too.
    const page404 = deps({ getThread: vi.fn(async () => ({ ok: false, status: 404, error: "not found" })) as never });
    const r2 = await fetchThreadRead(noDelta(), "a", base, page404);
    expect(!r2.ok && r2.gone).toBe(true);
  });

  it("no key, no cached seq, or no conversation id: the newest page (never after_seq)", async () => {
    const cases: [ReturnType<typeof fakeScope>, CacheBase][] = [
      [noDelta(), { messages: [msg(1)], conversationId: "c1" }],
      [withDelta(), null],
      [withDelta(), { messages: [], conversationId: "c1" }],
      [withDelta(), { messages: [msg(1)], conversationId: null }],
    ];
    for (const [scope, base] of cases) {
      const d = deps();
      const r = ok(await fetchThreadRead(scope, "a", base, d));
      expect(r.mode).toBe("page");
      expect(d.fetchThreadDelta).not.toHaveBeenCalled();
    }
  });

  it("the page path keeps 'the server wins in its window'", () => {
    const read = { ok: true as const, mode: "page" as const, steps: [], page: [msg(5), msg(7)], hasMore: true, conversationId: "c1", counts: { items: 2, changed: 0, removed: 0, pages: 0 }, bytes: null };
    expect(ids(applyThreadRead([msg(1), msg(5), msg(6), msg(7)], read))).toEqual(["m1", "m5", "m7"]);
  });
});

describe("project chat revalidation", () => {
  const line = (seq: number): ProjectGroupMessage => ({ id: `g${seq}`, groupId: "grp", author: "a", body: `b${seq}`, createdAt: seq, seq });
  const cachedLine = (seq: number, pos: number) => msg(pos, { id: `g${seq}`, readSeq: seq });

  it("delta after the newest line seq; lines appended in order", async () => {
    const d = deps({
      fetchProjectGroupDelta: vi.fn(async () => ({
        ok: true,
        data: { items: [line(12)], changed: [], removed: [], hasMore: false, conversationId: null, bytes: 1 },
      })) as never,
    });
    const cached = [cachedLine(10, 0), cachedLine(11, 1)];
    const r = ok(await fetchGroupRead(withDelta(), "grp", { messages: cached, conversationId: null }, d));
    expect(d.fetchProjectGroupDelta).toHaveBeenCalledWith(expect.anything(), "grp", 11, 50);
    const out = applyGroupRead(cached, r);
    expect(ids(out)).toEqual(["g10", "g11", "g12"]);
    expect(out.map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("has_more: pages forward by line seq; past four pages the newest page replaces", async () => {
    const paged = vi.fn(async (_s: unknown, _g: string, after: number) => ({
      ok: true,
      data: { items: [line(after + 1)], changed: [], removed: [], hasMore: after < 12, conversationId: null, bytes: 1 },
    }));
    const d = deps({ fetchProjectGroupDelta: paged as never });
    const cached = [cachedLine(10, 0), cachedLine(11, 1)];
    const r = ok(await fetchGroupRead(withDelta(), "grp", { messages: cached, conversationId: null }, d));
    expect(paged.mock.calls.map((c) => c[2])).toEqual([11, 12]);
    expect(ids(applyGroupRead(cached, r))).toEqual(["g10", "g11", "g12", "g13"]);

    const endless = vi.fn(async (_s: unknown, _g: string, after: number) => ({
      ok: true,
      data: { items: [line(after + 1)], changed: [], removed: [], hasMore: true, conversationId: null, bytes: 1 },
    }));
    const d2 = deps({
      fetchProjectGroupDelta: endless as never,
      fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [line(90), line(91)], truncated: true } })) as never,
    });
    const r2 = ok(await fetchGroupRead(withDelta(), "grp", { messages: cached, conversationId: null }, d2));
    expect(endless).toHaveBeenCalledTimes(4);
    expect(r2.mode).toBe("replace");
    const out = applyGroupRead(cached, r2);
    expect(ids(out)).toEqual(["g90", "g91"]);
    expect(out.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("404: the project is gone", async () => {
    const d = deps({ fetchProjectGroupDelta: vi.fn(async () => ({ ok: false, status: 404, error: "not found" })) as never });
    const r = await fetchGroupRead(withDelta(), "grp", { messages: [cachedLine(10, 0)], conversationId: null }, d);
    expect(!r.ok && r.gone).toBe(true);
    const p = deps({ fetchProjectGroupMessages: vi.fn(async () => ({ ok: false, status: 404, error: "x" })) as never });
    const r2 = await fetchGroupRead(noDelta(), "grp", null, p);
    expect(!r2.ok && r2.gone).toBe(true);
  });

  it("lines without their own seq (older server): the newest page", async () => {
    const d = deps();
    const r = ok(await fetchGroupRead(withDelta(), "grp", { messages: [msg(0, { id: "g1" })], conversationId: null }, d));
    expect(r.mode).toBe("page");
    expect(d.fetchProjectGroupDelta).not.toHaveBeenCalled();
  });
});
