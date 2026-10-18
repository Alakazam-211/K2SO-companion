import { describe, expect, it } from "vitest";
import { moveIndex, rearrangeShift, rearrangeTarget } from "./useRearrange";

// Rows 70px tall: middles at 35, 105, 175, 245.
const MIDS = [35, 105, 175, 245];

describe("rearrange geometry", () => {
  it("the target slot is how many other middles sit above the dragged middle", () => {
    expect(rearrangeTarget(MIDS, 0, 35)).toBe(0);
    expect(rearrangeTarget(MIDS, 0, 104)).toBe(0);
    expect(rearrangeTarget(MIDS, 0, 106)).toBe(1);
    expect(rearrangeTarget(MIDS, 0, 400)).toBe(3);
    expect(rearrangeTarget(MIDS, 3, 0)).toBe(0);
    expect(rearrangeTarget(MIDS, 3, 150)).toBe(2);
  });

  it("rows between slide by the dragged row's height, toward its old slot", () => {
    // 0 dragged down to 2: rows 1 and 2 slide up.
    expect([0, 1, 2, 3].map((i) => rearrangeShift(i, 0, 2, 70))).toEqual([0, -70, -70, 0]);
    // 3 dragged up to 1: rows 1 and 2 slide down.
    expect([0, 1, 2, 3].map((i) => rearrangeShift(i, 3, 1, 70))).toEqual([0, 70, 70, 0]);
    // Over its own slot: nothing moves.
    expect([0, 1, 2, 3].map((i) => rearrangeShift(i, 2, 2, 70))).toEqual([0, 0, 0, 0]);
  });

  it("moveIndex moves one item", () => {
    expect(moveIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
});
