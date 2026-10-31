import { describe, expect, it, vi } from "vitest";
import {
  STASH_PUSH_MAX_RECORDS,
  emitStashFrame,
  onStashFrame,
  parseStashFrame,
  parseStashPull,
  parseStashPush,
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
