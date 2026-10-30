import { describe, expect, it } from "vitest";
import {
  STASH_MAX,
  TOMBSTONE_KEEP_MS,
  expiredTombstones,
  insertBelow,
  liveStash,
  makeStashItem,
  oldestLive,
  missingFilesNote,
  parseStashItem,
  stashAge,
  stashIsFull,
  stashPreview,
  stashSourceLabel,
  tombstone,
} from "./stashModel";

describe("stash model (shared schema with K2 0.46.7)", () => {
  it("a new item: v1, stable id, snake_case ms epochs, live", () => {
    const it1 = makeStashItem({ text: "hi", now: 1000, source: { agent: "k2", server_label: "rosson" } });
    expect(it1).toMatchObject({
      v: 1,
      text: "hi",
      attachments: [],
      quotes: [],
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      source: { server_id: null, server_label: "rosson", user: null, agent: "k2", agent_name: null },
    });
    expect(it1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
    expect(stashPreview({ text: "", attachments: [{ id: "a", name: "a.png", type: "", size: 1, device_id: null, path: null }] })).toBe("a.png");
    expect(stashSourceLabel({ server_id: "s", server_label: "rosson", user: "u", agent: "k2", agent_name: "K2" })).toBe("K2 · rosson");
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

  it("reads early test builds' camelCase source; writes snake_case", () => {
    const old = parseStashItem({
      v: 1,
      id: "a",
      created_at: 1,
      text: "x",
      source: { serverId: "rosson.k2.dev", serverLabel: "rosson", agentName: "Appa", agent: "appa", user: "u" },
    });
    expect(old?.source).toEqual({ server_id: "rosson.k2.dev", server_label: "rosson", user: "u", agent: "appa", agent_name: "Appa" });
  });

  it("a newer schema's record is kept but hidden: not listed, counted or expired", () => {
    const newer = { ...makeStashItem({ text: "from v2", now: 0 }), v: 2 };
    const deadNewer = { ...tombstone(makeStashItem({ text: "x", now: 0 }), 0), v: 2 };
    expect(liveStash([newer])).toEqual([]);
    expect(expiredTombstones([deadNewer], TOMBSTONE_KEEP_MS * 2)).toEqual([]);
  });

  it("an attachment is a reference: device and path, read from synced records, null when absent", () => {
    const rec = {
      v: 1,
      id: "s1",
      text: "x",
      created_at: 1,
      updated_at: 1,
      attachments: [
        { id: "a", name: "shot.png", type: "image/png", size: 3, device_id: "mac-1", path: "/Users/r/shot.png" },
        { id: "b", name: "old.txt", type: "text/plain", size: 1 },
      ],
    };
    expect(parseStashItem(rec)?.attachments).toEqual([
      { id: "a", name: "shot.png", type: "image/png", size: 3, device_id: "mac-1", path: "/Users/r/shot.png" },
      { id: "b", name: "old.txt", type: "text/plain", size: 1, device_id: null, path: null },
    ]);
  });

  it("missingFilesNote says whether files are on another device or unreadable", () => {
    expect(missingFilesNote([])).toBe("");
    expect(missingFilesNote([{ name: "shot.png", elsewhere: true }])).toBe("shot.png wasn't restored: it's on another device.");
    expect(missingFilesNote([{ name: "shot.png", elsewhere: false }])).toBe("shot.png couldn't be restored.");
    expect(missingFilesNote([{ name: "a", elsewhere: true }, { name: "b", elsewhere: true }])).toBe(
      "2 files weren't restored: they're on another device."
    );
    expect(missingFilesNote([{ name: "a", elsewhere: true }, { name: "b", elsewhere: false }])).toBe("2 files couldn't be restored.");
    const names = new Map([["mac-1", "Rosson's MacBook"], ["mini", "Studio Mini"]]);
    expect(missingFilesNote([{ name: "shot.png", elsewhere: true, device_id: "mac-1" }], names)).toBe(
      "shot.png wasn't restored: it's on Rosson's MacBook."
    );
    // A removed device isn't in the list.
    expect(missingFilesNote([{ name: "shot.png", elsewhere: true, device_id: "gone" }], names)).toBe(
      "shot.png wasn't restored: it's on another device."
    );
    expect(
      missingFilesNote(
        [
          { name: "a", elsewhere: true, device_id: "mac-1" },
          { name: "b", elsewhere: true, device_id: "mac-1" },
        ],
        names
      )
    ).toBe("2 files weren't restored: they're on Rosson's MacBook.");
    expect(
      missingFilesNote(
        [
          { name: "a", elsewhere: true, device_id: "mac-1" },
          { name: "b", elsewhere: true, device_id: "mini" },
        ],
        names
      )
    ).toBe("2 files weren't restored: they're on other devices.");
  });
});
