import { describe, expect, it } from "vitest";
import { assignOrders, compareOrder, isOrderKey, isValidOrder, normalizeOrder, orderBetween } from "./fracIndex";

// The first four cases are K2's `src/renderer/lib/fractional-index.test.ts`
// unchanged: the phone must give the desktop's (and Rust's) keys.
describe("fractional-index (homes-sync-v1 order keys) — desktop parity", () => {
  it("matches the Rust helper on the shared fixtures", () => {
    // Same values as k2_core::homes_sync::tests::order_between_matches_the_client_helper.
    expect(orderBetween(null, null)).toBe("V");
    expect(orderBetween("V", null)).toBe("l");
    expect(orderBetween(null, "V")).toBe("G");
    expect(orderBetween("z", null)).toBe("zV");
    expect(orderBetween("a", "b")).toBe("aV");
    expect(orderBetween("a1", "a2")).toBe("a1V");
    expect(orderBetween(null, "05")).toBe("03");
  });

  it("refuses bad input loudly", () => {
    expect(() => orderBetween("b", "a")).toThrow(/out of order/);
    expect(() => orderBetween("a", "a")).toThrow(/out of order/);
    expect(() => orderBetween("a0", null)).toThrow(/invalid/);
    expect(() => orderBetween("a.b", null)).toThrow(/invalid/);
    expect(isValidOrder("")).toBe(false);
    expect(isValidOrder("V")).toBe(true);
  });

  it("stays strictly ordered over long runs of appends, prepends and squeezes", () => {
    const keys = [orderBetween(null, null)];
    for (let i = 0; i < 200; i++) {
      keys.push(orderBetween(keys[keys.length - 1], null));
      keys.unshift(orderBetween(null, keys[0]));
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
      expect(isValidOrder(keys[i])).toBe(true);
    }
    let lo = "V";
    for (let i = 0; i < 100; i++) {
      const m = orderBetween(lo, "W");
      expect(lo < m && m < "W" && isValidOrder(m)).toBe(true);
      lo = m;
    }
  });

  it("assignOrders keeps every key it can: one move rewrites one key", () => {
    const known: Record<string, string> = { a: "G", b: "V", c: "l", d: "t" };
    // Move d to the front.
    const list = ["d", "a", "b", "c"];
    const out = assignOrders(list.length, (i) => known[list[i]] ?? null);
    expect(out.slice(1)).toEqual(["G", "V", "l"]);
    expect(out[0] < "G").toBe(true);
    // New entries go between their neighbours; unknown keys are filled.
    const list2 = ["a", "x", "b", "y"];
    const out2 = assignOrders(list2.length, (i) => known[list2[i]] ?? null);
    expect(out2[0]).toBe("G");
    expect(out2[2]).toBe("V");
    expect("G" < out2[1] && out2[1] < "V").toBe(true);
    expect(out2[3] > "V").toBe(true);
    // Duplicate keys (two devices inserted at the same spot) get separated.
    const dup = assignOrders(3, () => "V");
    expect(dup[0] < dup[1] && dup[1] < dup[2]).toBe(true);
    // No keys at all: a fresh increasing run.
    const fresh = assignOrders(4, () => null);
    expect([...fresh].sort()).toEqual(fresh);
    expect(new Set(fresh).size).toBe(4);
  });

  it("the contract's example: ('a','b') → 'aV'; a fresh list is V, l, t…", () => {
    expect(orderBetween("a", "b")).toBe("aV");
    expect(assignOrders(3, () => null)).toEqual(["V", "l", "t"]);
  });
});

describe("phone helpers", () => {
  it("isOrderKey: any value; keys ending in 0 (pre-final phone keys) are invalid", () => {
    expect(isOrderKey("V")).toBe(true);
    expect(isOrderKey("a1")).toBe(true);
    expect(isOrderKey("a0")).toBe(false);
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("a!")).toBe(false);
    expect(isOrderKey(3)).toBe(false);
    expect(isOrderKey("x".repeat(129))).toBe(false);
  });

  it("compareOrder: plain string order, missing last", () => {
    expect(["a1", undefined, "Zz", "a0V"].sort(compareOrder)).toEqual(["Zz", "a0V", "a1", undefined]);
  });

  it("normalizeOrder = assignOrders over items, reporting what changed", () => {
    const fresh = normalizeOrder([{ id: "a" }, { id: "b" }, { id: "c" }] as { id: string; order?: string }[]);
    expect(fresh.items.map((i) => i.order)).toEqual(["V", "l", "t"]);
    expect(fresh.changed).toEqual([0, 1, 2]);

    // Move c to the top: only c gets a new key.
    const moved = normalizeOrder([fresh.items[2], fresh.items[0], fresh.items[1]]);
    expect(moved.changed).toEqual([0]);
    expect(moved.items[0].order! < "V").toBe(true);
    expect(moved.items.map((i) => i.id)).toEqual(["c", "a", "b"]);

    // Already in order: nothing changes (same objects).
    const same = normalizeOrder(fresh.items);
    expect(same.changed).toEqual([]);
    expect(same.items[0]).toBe(fresh.items[0]);

    // An invalid key (an old `a0`-style key, or junk) is replaced in place.
    const bad = normalizeOrder([{ order: "G" }, { order: "zz!" }, { order: "l" }]);
    expect(bad.changed).toEqual([1]);
    expect(bad.items[1].order! > "G" && bad.items[1].order! < "l").toBe(true);
    const old = normalizeOrder([{ order: "a0" }, { order: "a1" }]);
    expect(old.changed).toEqual([0]);
    expect(old.items[0].order! < "a1").toBe(true);
  });
});
