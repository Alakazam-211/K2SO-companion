import { describe, expect, it, vi } from "vitest";
import {
  STASH_PUSH_MAX_RECORDS,
  emitStashFrame,
  onStashFrame,
  parseStashFrame,
  parseStashPull,
  parseStashPush,
  stashFitsServer,
  stashPushBatches,
} from "./stashSync";
import { makeStashItem } from "../zen/stash/stashModel";

describe("stash-sync-v1 wire", () => {
  it("reads a pull: cursor, full, records (unreadable ones skipped)", () => {
    const rec = { v: 1, id: "a", text: "x", created_at: 1, updated_at: 2, updated_by: "mac-1", deleted_at: null };
    expect(parseStashPull({ ok: true, cursor: 7, full: true, changes: [rec, { nope: 1 }] })).toEqual({
      cursor: 7,
      full: true,
      changes: [expect.objectContaining({ id: "a", text: "x", updated_by: "mac-1" })],
    });
    expect(parseStashPull(null)).toEqual({ cursor: null, full: false, changes: [] });
  });

  it("reads a push: counts and rejections by record id", () => {
    expect(
      parseStashPush({ ok: true, cursor: 9, applied: 2, superseded: 1, rejected: [{ item: { id: "z" }, reason: "cap_reached" }, {}] })
    ).toEqual({
      cursor: 9,
      applied: 2,
      superseded: 1,
      rejected: [
        { id: "z", reason: "cap_reached" },
        { id: null, reason: "rejected" },
      ],
    });
  });

  it("splits pushes at 200 records and under 4 MiB", () => {
    const many = Array.from({ length: STASH_PUSH_MAX_RECORDS + 5 }, (_, i) => makeStashItem({ text: `t${i}` }));
    expect(stashPushBatches(many).map((b) => b.length)).toEqual([STASH_PUSH_MAX_RECORDS, 5]);
    const big = Array.from({ length: 40 }, () => makeStashItem({ text: "x".repeat(100_000) }));
    const batches = stashPushBatches(big);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThan(4 * 1024 * 1024);
    expect(batches.flat()).toHaveLength(40);
  });

  it("measures pushes in UTF-8 bytes", () => {
    // 3 bytes a character: 40 × 90 000 characters is ~10.8 MB of UTF-8.
    const big = Array.from({ length: 40 }, () => makeStashItem({ text: "€".repeat(90_000) }));
    for (const b of stashPushBatches(big)) {
      expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(4 * 1024 * 1024);
    }
  });

  it("a record fits the server's limits: 20 000 characters (Unicode), 10 files, 20 quotes, 128 KiB", () => {
    expect(stashFitsServer(makeStashItem({ text: "x".repeat(20_000) }))).toBe(true);
    expect(stashFitsServer(makeStashItem({ text: "x".repeat(20_001) }))).toBe(false);
    // 20 000 emoji are 40 000 UTF-16 units but 20 000 characters (and under 128 KiB).
    expect(stashFitsServer(makeStashItem({ text: "😀".repeat(20_000) }))).toBe(true);
    const file = { id: "f", name: "a", type: "text/plain", size: 1, device_id: "d", path: null };
    expect(stashFitsServer(makeStashItem({ text: "a", attachments: Array.from({ length: 11 }, (_, i) => ({ ...file, id: `f${i}` })) }))).toBe(false);
  });

  it("stash_changed reaches listeners with its cursor; other frames don't", () => {
    expect(parseStashFrame({ kind: "stash_changed", cursor: 4 })).toEqual({ cursor: 4 });
    expect(parseStashFrame({ type: "stash_changed", data: { cursor: 5 } })).toEqual({ cursor: 5 });
    expect(parseStashFrame({ kind: "homes_changed", cursor: 4 })).toBeUndefined();
    const fn = vi.fn();
    const off = onStashFrame(fn);
    expect(emitStashFrame("srv", { kind: "stash_changed", cursor: 3 })).toBe(true);
    expect(emitStashFrame("srv", { kind: "thread_message" })).toBe(false);
    off();
    expect(fn).toHaveBeenCalledExactlyOnceWith("srv", 3);
  });
});
