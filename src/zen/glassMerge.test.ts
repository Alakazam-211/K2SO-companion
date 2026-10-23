import { describe, expect, it } from "vitest";
import { MERGE_K, mergedDistance, sdBox, shapeFromRect, smin, type GlassShape } from "./glassMerge";

const circle = (cx: number, cy: number, r: number): GlassShape => ({ cx, cy, hx: r, hy: r, r });

describe("merged header glass (SDF)", () => {
  it("rounded box: negative inside, zero on the edge, distance outside", () => {
    const s = circle(0, 0, 18);
    expect(sdBox(0, 0, s)).toBeCloseTo(-18);
    expect(sdBox(18, 0, s)).toBeCloseTo(0);
    expect(sdBox(30, 0, s)).toBeCloseTo(12);
    const pill: GlassShape = { cx: 0, cy: 0, hx: 100, hy: 25, r: 25 };
    expect(sdBox(0, 25, pill)).toBeCloseTo(0);
    expect(sdBox(110, 0, pill)).toBeCloseTo(10);
  });

  it("smin: a plain min when far apart, a deeper join within k", () => {
    expect(smin(5, 40, MERGE_K)).toBe(5);
    expect(smin(5, 5, MERGE_K)).toBeLessThan(5);
    expect(smin(3, 7, 0)).toBe(3);
  });

  it("the pill grows a neck into a button it nears; buttons never merge with each other", () => {
    const a = circle(0, 0, 18);
    const b = circle(44, 0, 18); // 8px apart, as the header's right buttons
    // Midway between two buttons: outside (no button-to-button merge).
    expect(mergedDistance(22, 0, [a, b], null)).toBeCloseTo(4);
    // A pill 6px below button a: the gap is bridged (inside the union).
    const near: GlassShape = { cx: 0, cy: 18 + 6 + 25, hx: 120, hy: 25, r: 25 };
    expect(mergedDistance(0, 21, [a], near)).toBeLessThan(0);
    // 30px below: no bridge, the gap stays outside.
    const far: GlassShape = { cx: 0, cy: 18 + 30 + 25, hx: 120, hy: 25, r: 25 };
    expect(mergedDistance(0, 33, [a], far)).toBeGreaterThan(0);
    // Far from both: plain distance.
    expect(mergedDistance(0, -100, [a], near)).toBeCloseTo(82);
  });

  it("shapes come from element boxes relative to the layer", () => {
    const base = { left: 10, top: 20 } as DOMRect;
    const r = { left: 20, top: 30, width: 36, height: 36 } as DOMRect;
    expect(shapeFromRect(r, base)).toEqual({ cx: 28, cy: 28, hx: 18, hy: 18, r: 18 });
  });
});
