import { describe, expect, it } from "vitest";
import { compareOrder, isOrderKey, keyBetween, nKeysBetween, normalizeOrder } from "./fracIndex";

describe("fractional index keys (homes sync order)", () => {
  it("starts at a0 and walks both ways", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    expect(keyBetween("a0", "a1")).toBe("a0V");
    expect(keyBetween("a0", "a0V")).toBe("a0G");
    expect(keyBetween("a1", "a2")).toBe("a1V");
    expect(keyBetween("az", null)).toBe("b00");
  });

  it("every key sits strictly between its neighbours (string compare)", () => {
    let lo = "a0";
    let hi = "a1";
    for (let i = 0; i < 50; i++) {
      const k = keyBetween(lo, hi);
      expect(lo < k && k < hi).toBe(true);
      if (i % 2) lo = k;
      else hi = k;
    }
  });

  it("refuses bad input", () => {
    expect(() => keyBetween("a1", "a0")).toThrow();
    expect(() => keyBetween("a0", "a0")).toThrow();
    expect(isOrderKey("a0")).toBe(true);
    expect(isOrderKey("a00")).toBe(false); // trailing zero
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("a!")).toBe(false);
    expect(isOrderKey(3)).toBe(false);
  });

  it("n keys between are increasing and inside the range", () => {
    for (const [a, b] of [
      [null, null],
      ["a0", null],
      [null, "a0"],
      ["a0", "a1"],
    ] as const) {
      const ks = nKeysBetween(a, b, 7);
      expect(ks).toHaveLength(7);
      for (let i = 1; i < ks.length; i++) expect(ks[i - 1] < ks[i]).toBe(true);
      if (a) expect(ks[0] > a).toBe(true);
      if (b) expect(ks[6] < b).toBe(true);
    }
  });

  it("compareOrder: plain string order, missing last", () => {
    expect(["a1", undefined, "Zz", "a0V"].sort(compareOrder)).toEqual(["Zz", "a0V", "a1", undefined]);
  });

  it("normalizeOrder keys missing items and re-keys only what a move broke", () => {
    const fresh = normalizeOrder([{ id: "a" }, { id: "b" }, { id: "c" }] as { id: string; order?: string }[]);
    expect(fresh.items.map((i) => i.order)).toEqual(["a0", "a1", "a2"]);
    expect(fresh.changed).toEqual([0, 1, 2]);

    // Move c to the top: only c gets a new key.
    const moved = normalizeOrder([fresh.items[2], fresh.items[0], fresh.items[1]]);
    expect(moved.changed).toEqual([0]);
    expect(moved.items[0].order! < "a0").toBe(true);
    expect(moved.items.map((i) => i.id)).toEqual(["c", "a", "b"]);

    // Already in order: nothing changes.
    expect(normalizeOrder(fresh.items).changed).toEqual([]);

    // An invalid key is replaced in place.
    const bad = normalizeOrder([{ order: "a0" }, { order: "zz!" }, { order: "a2" }]);
    expect(bad.changed).toEqual([1]);
    expect(bad.items[1].order! > "a0" && bad.items[1].order! < "a2").toBe(true);
  });
});
