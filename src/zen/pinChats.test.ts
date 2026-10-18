import { describe, expect, it } from "vitest";
import * as pinChats from "./pinChats";

const { LEGACY_PIN_STORAGE_KEY, clearLegacyPinStore, dropIsPins, insertPinned } = pinChats;

describe("pinChats", () => {
  it("the per-device pin store is gone: no read/write, and the old key is cleared", () => {
    const mod = pinChats as Record<string, unknown>;
    expect(mod.readPinnedIds).toBeUndefined();
    expect(mod.writePinnedIds).toBeUndefined();
    expect(mod.pinId).toBeUndefined();
    expect(mod.unpinId).toBeUndefined();
    const store = new Map<string, string>([[LEGACY_PIN_STORAGE_KEY, '["a"]']]);
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = ls;
    try {
      clearLegacyPinStore();
      expect(store.has(LEGACY_PIN_STORAGE_KEY)).toBe(false);
    } finally {
      g.localStorage = prev;
    }
  });

  it("drop zone is the pin grid plus a little slack", () => {
    const r = { left: 0, right: 100, top: 0, bottom: 80 };
    expect(dropIsPins(50, 40, r)).toBe(true);
    expect(dropIsPins(50, 90, r)).toBe(true);
    expect(dropIsPins(50, 100, r)).toBe(false);
    expect(dropIsPins(-1, 40, r)).toBe(false);
  });

  it("reorders a pin before another, or to the end", () => {
    expect(insertPinned(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(insertPinned(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(insertPinned(["a", "b"], "a", null)).toEqual(["b", "a"]);
    expect(insertPinned(["a"], "b", "a")).toEqual(["b", "a"]);
  });
});

describe("pin drag preview", () => {
  // Three cells in a row, 100px apart.
  const slots = ["a", "b", "c"].map((id, i) => ({ id, left: i * 100, top: 0, width: 80, height: 80 }));

  it("moves the lifted pin to the nearest cell; off the grid keeps the order", () => {
    expect(pinChats.pinPreviewOrder(slots, "a", 240, 40, true)).toEqual(["b", "c", "a"]);
    expect(pinChats.pinPreviewOrder(slots, "c", 30, 40, true)).toEqual(["c", "a", "b"]);
    expect(pinChats.pinPreviewOrder(slots, "a", 240, 40, false)).toEqual(["a", "b", "c"]);
  });

  it("slides the others into the cells they make room in", () => {
    const order = pinChats.pinPreviewOrder(slots, "a", 240, 40, true);
    expect(pinChats.pinSlotOffset(slots, order, "b")).toEqual({ dx: -100, dy: 0 });
    expect(pinChats.pinSlotOffset(slots, order, "a")).toEqual({ dx: 200, dy: 0 });
    expect(pinChats.pinSlotOffset(slots, ["a", "b", "c"], "b")).toBeNull();
  });
});
