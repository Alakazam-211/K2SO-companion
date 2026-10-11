import { describe, expect, it, vi } from "vitest";

const { getThread } = vi.hoisted(() => ({ getThread: vi.fn() }));
vi.mock("../api/client", () => ({ getThread }));
vi.mock("../api/projectGroups", () => ({ fetchProjectGroupMessages: vi.fn() }));

import {
  LAST_AT_CAP,
  beginLastAt,
  fetchLastAt,
  groupLastAt,
  lastAtKey,
  lastAtKeyFor,
  parseLastAtKey,
  resetLastAtQueue,
  sortChatsByRecency,
  threadLastAt,
} from "./lastAtFetch";
import { fakeScope } from "../test/fakeScope";

describe("threadLastAt", () => {
  it("takes created_at from the highest seq, not lastInteractionAt", () => {
    expect(
      threadLastAt([
        { seq: 20, doc: { seq: 20, from: "a", body: "old", created_at: 10 } },
        { seq: 22, doc: { seq: 22, from: "baden", body: "new", created_at: 50 } },
      ])
    ).toBe(50);
    expect(threadLastAt([])).toBeNull();
  });
});

describe("groupLastAt", () => {
  it("uses the last message of an oldest-first page", () => {
    expect(
      groupLastAt([
        { createdAt: 1 },
        { createdAt: 1789088677 },
      ])
    ).toBe(1789088677);
    expect(groupLastAt([])).toBeNull();
  });
});

describe("sortChatsByRecency", () => {
  it("puts the newest last-message row first", () => {
    const rows = [
      { name: "old", addr: "old" },
      { name: "new", addr: "new" },
      { name: "mid", addr: "mid" },
    ];
    const sorted = sortChatsByRecency(
      rows,
      { "s1|t:old": 10, "s1|t:new": 50, "s1|t:mid": 20 },
      (r) => lastAtKeyFor("s1", r)
    );
    expect(sorted.map((r) => r.name)).toEqual(["new", "mid", "old"]);
  });

  it("keeps untimed rows under timed ones, in original order", () => {
    const rows = [
      { name: "a", addr: "a" },
      { name: "b", addr: "b" },
      { name: "c", addr: "c" },
    ];
    const sorted = sortChatsByRecency(rows, { "s1|t:b": 100 }, (r) => lastAtKeyFor("s1", r));
    expect(sorted.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
});

describe("beginLastAt", () => {
  it("de-dupes a row so scrolling does not refetch", () => {
    resetLastAtQueue();
    expect(LAST_AT_CAP).toBe(3);
    expect(beginLastAt("s1|t:appa")).toBe(true);
    expect(beginLastAt("s1|t:appa")).toBe(false);
    expect(beginLastAt("s1|t:skin-test-a")).toBe(true);
  });

  it("keys are per server: the same addr on two servers is two rows (MA6)", () => {
    resetLastAtQueue();
    expect(lastAtKey("s1", "thread", "appa")).toBe("s1|t:appa");
    expect(lastAtKey("s2", "group", "g1")).toBe("s2|g:g1");
    expect(parseLastAtKey("s2|g:g1")).toEqual({ serverId: "s2", kind: "group", id: "g1" });
    expect(parseLastAtKey("t:appa")).toBeNull();
    expect(beginLastAt("s1|t:appa")).toBe(true);
    expect(beginLastAt("s2|t:appa")).toBe(true);
  });
});

describe("fetchLastAt", () => {
  it("caps in-flight reads per server, not across servers (MA6)", async () => {
    resetLastAtQueue();
    const gates: Array<() => void> = [];
    getThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve({ ok: true, data: { items: [] } }));
        })
    );
    const a = fakeScope({ id: "a" });
    const b = fakeScope({ id: "b" });
    const runs = [
      ...Array.from({ length: LAST_AT_CAP + 1 }, (_, i) => fetchLastAt(a, "thread", `a${i}`)),
      fetchLastAt(b, "thread", "b0"),
    ];
    await Promise.resolve();
    await Promise.resolve();
    // a: CAP in flight + 1 queued; b is not blocked by a's queue.
    const scopesCalled = getThread.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(scopesCalled.filter((id) => id === "a")).toHaveLength(LAST_AT_CAP);
    expect(scopesCalled).toContain("b");
    while (gates.length) {
      gates.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(runs);
    expect(getThread).toHaveBeenCalledTimes(LAST_AT_CAP + 2);
  });
});
