import { describe, expect, it } from "vitest";
import * as pinChats from "./pinChats";

const { LEGACY_PIN_STORAGE_KEY, clearLegacyPinStore, dropIsPins, insertPinned, isListPan } = pinChats;

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

  it("a mostly-vertical move is a list pan, not a lift", () => {
    expect(isListPan(2, 20)).toBe(true);
    expect(isListPan(20, 2)).toBe(false);
  });

  it("reorders a pin before another, or to the end", () => {
    expect(insertPinned(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(insertPinned(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(insertPinned(["a", "b"], "a", null)).toEqual(["b", "a"]);
    expect(insertPinned(["a"], "b", "a")).toEqual(["b", "a"]);
  });
});
