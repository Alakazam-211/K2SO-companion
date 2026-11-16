import { describe, expect, it } from "vitest";
import { resolveAllColorMix, resolveColorMix } from "./colorMix";

describe("resolveColorMix (iOS 15–16.1 have no color-mix)", () => {
  it("mixes two colours in sRGB, the missing percentage being the rest", () => {
    expect(resolveColorMix("color-mix(in srgb, #0a84ff 82%, white)", {})).toBe("#369aff");
    expect(resolveColorMix("color-mix(in srgb, #000000 50%, #ffffff)", {})).toBe("#808080");
    expect(resolveColorMix("color-mix(in srgb, #000000, #ffffff 25%)", {})).toBe("#404040");
  });

  it("follows var() through the palette, nested", () => {
    const vars = { "--glass-accent": "#0a84ff", "--color-accent": "var(--glass-accent)" };
    expect(resolveColorMix("color-mix(in srgb, var(--color-accent) 82%, black)", vars)).toBe("#086cd1");
  });

  it("mixes with transparent using premultiplied alpha (desktop's tile edge)", () => {
    const vars = { "--color-border": "#333333", "--color-text-primary": "#ffffff" };
    const edge = resolveColorMix(
      "color-mix(in srgb, var(--color-border) 55%, color-mix(in srgb, var(--color-text-primary) 14%, transparent))",
      vars
    );
    // 55% of opaque #333 plus 45% of white at 14%: alpha .55 + .063 = .613;
    // red (51 × .55 + 255 × .14 × .45) / .613 = 72.
    expect(edge).toBe("rgba(72, 72, 72, 0.613)");
    expect(resolveColorMix("color-mix(in srgb, black 8%, transparent)", {})).toBe("rgba(0, 0, 0, 0.08)");
  });

  it("resolves a mix inside a longer value and leaves the rest", () => {
    expect(resolveColorMix("0 10px 30px color-mix(in srgb, black 8%, transparent)", {})).toBe(
      "0 10px 30px rgba(0, 0, 0, 0.08)"
    );
    expect(resolveColorMix("inset 0 1px 0 var(--color-ring-edge-strong)", {})).toBe(
      "inset 0 1px 0 var(--color-ring-edge-strong)"
    );
  });

  it("leaves what it can't read as written", () => {
    expect(resolveColorMix("color-mix(in oklch, red, blue)", {})).toBe("color-mix(in oklch, red, blue)");
    expect(resolveColorMix("color-mix(in srgb, var(--nope) 50%, white)", {})).toBe(
      "color-mix(in srgb, var(--nope) 50%, white)"
    );
  });

  it("resolveAllColorMix resolves each property against the whole set", () => {
    const out = resolveAllColorMix({ "--a": "#ff0000", "--b": "color-mix(in srgb, var(--a) 50%, black)" });
    expect(out).toEqual({ "--a": "#ff0000", "--b": "#800000" });
  });
});
