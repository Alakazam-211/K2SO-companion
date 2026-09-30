import { describe, expect, it } from "vitest";
import {
  LAST_AT_CAP,
  beginLastAt,
  groupLastAt,
  lastAtKeyFor,
  resetLastAtQueue,
  sortChatsByRecency,
  threadLastAt,
} from "./lastAtFetch";

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
      { "t:old": 10, "t:new": 50, "t:mid": 20 },
      lastAtKeyFor
    );
    expect(sorted.map((r) => r.name)).toEqual(["new", "mid", "old"]);
  });

  it("keeps untimed rows under timed ones, in original order", () => {
    const rows = [
      { name: "a", addr: "a" },
      { name: "b", addr: "b" },
      { name: "c", addr: "c" },
    ];
    const sorted = sortChatsByRecency(rows, { "t:b": 100 }, lastAtKeyFor);
    expect(sorted.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
});

describe("beginLastAt", () => {
  it("de-dupes a row so scrolling does not refetch", () => {
    resetLastAtQueue();
    expect(LAST_AT_CAP).toBe(3);
    expect(beginLastAt("t:appa")).toBe(true);
    expect(beginLastAt("t:appa")).toBe(false);
    expect(beginLastAt("t:skin-test-a")).toBe(true);
  });
});
