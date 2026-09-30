import { describe, expect, it } from "vitest";
import {
  LAST_AT_CAP,
  beginLastAt,
  groupLastAt,
  resetLastAtQueue,
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

describe("beginLastAt", () => {
  it("de-dupes a row so scrolling does not refetch", () => {
    resetLastAtQueue();
    expect(LAST_AT_CAP).toBe(3);
    expect(beginLastAt("t:appa")).toBe(true);
    expect(beginLastAt("t:appa")).toBe(false);
    expect(beginLastAt("t:skin-test-a")).toBe(true);
  });
});
