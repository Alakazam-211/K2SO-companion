import { describe, expect, it } from "vitest";
import {
  STASH_MAX,
  TOMBSTONE_KEEP_MS,
  expiredTombstones,
  insertBelow,
  liveStash,
  makeStashItem,
  oldestLive,
  parseStashItem,
  stashAge,
  stashIsFull,
  stashPreview,
  stashSourceLabel,
  tombstone,
} from "./stashModel";

describe("stash model (shared schema with K2 0.46.7)", () => {
  it("a new item: v1, stable id, snake_case ms epochs, live", () => {
    const it1 = makeStashItem({ text: "hi", now: 1000, source: { agent: "k2", serverLabel: "rosson" } });
    expect(it1).toMatchObject({
      v: 1,
      text: "hi",
      attachments: [],
      quotes: [],
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      source: { serverId: null, serverLabel: "rosson", user: null, agent: "k2", agentName: null },
    });
    expect(it1.id).toBeTruthy();
    expect(parseStashItem(JSON.parse(JSON.stringify(it1)))).toEqual(it1);
  });

  it("live items newest first; the cap counts live items only", () => {
    const items = Array.from({ length: STASH_MAX }, (_, i) => makeStashItem({ text: `n${i}`, now: i }));
    expect(stashIsFull(items)).toBe(true);
    expect(liveStash(items)[0].text).toBe(`n${STASH_MAX - 1}`);
    expect(oldestLive(items)?.text).toBe("n0");
    const one = tombstone(items[3], 5000);
    expect(one).toMatchObject({ text: "", attachments: [], quotes: [], deleted_at: 5000, updated_at: 5000 });
    expect(stashIsFull(items.map((i) => (i.id === one.id ? one : i)))).toBe(false);
  });

  it("tombstones expire after 30 days", () => {
    const dead = tombstone(makeStashItem({ text: "x", now: 0 }), 0);
    expect(expiredTombstones([dead], TOMBSTONE_KEEP_MS)).toEqual([]);
    expect(expiredTombstones([dead], TOMBSTONE_KEEP_MS + 1)).toEqual([dead.id]);
  });

  it("insertBelow puts the stash under existing text after a blank line", () => {
    expect(insertBelow("", "stash")).toBe("stash");
    expect(insertBelow("   \n", "stash")).toBe("stash");
    expect(insertBelow("hello  \n\n", "stash")).toBe("hello\n\nstash");
  });

  it("preview, source and age", () => {
    expect(stashPreview({ text: "\n  first line \nsecond", attachments: [] })).toBe("first line");
    expect(stashPreview({ text: "", attachments: [{ id: "a", name: "a.png", type: "", size: 1 }] })).toBe("a.png");
    expect(stashSourceLabel({ serverId: "s", serverLabel: "rosson", user: "u", agent: "k2", agentName: "K2" })).toBe("K2 · rosson");
    expect(stashAge(0, 30_000)).toBe("now");
    expect(stashAge(0, 5 * 60_000)).toBe("5m");
    expect(stashAge(0, 3 * 3600_000)).toBe("3h");
    expect(stashAge(0, 2 * 86400_000)).toBe("2d");
    expect(stashAge(0, 15 * 86400_000)).toBe("2w");
  });

  it("parse rejects a record without id or created_at", () => {
    expect(parseStashItem({ text: "x" })).toBeNull();
    expect(parseStashItem({ id: "a", created_at: 1, text: 3 })).toMatchObject({ text: "", updated_at: 1 });
  });
});
