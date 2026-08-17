import { describe, expect, it } from "vitest";

import { supportsK1Grid } from "./capabilities";

describe("supportsK1Grid", () => {
  it("is true only when gridProto lists k1", () => {
    expect(supportsK1Grid({ gridProto: ["k1"] })).toBe(true);
    expect(supportsK1Grid({ gridProto: ["k1", "k2"] })).toBe(true);
  });

  it("is false on miss / old daemon shapes", () => {
    expect(supportsK1Grid(undefined)).toBe(false);
    expect(supportsK1Grid(null)).toBe(false);
    expect(supportsK1Grid({})).toBe(false);
    expect(supportsK1Grid({ gridProto: [] })).toBe(false);
    expect(supportsK1Grid({ gridProto: ["k0"] })).toBe(false);
    expect(supportsK1Grid({ status: "ok" })).toBe(false);
    expect(supportsK1Grid("k1")).toBe(false);
  });
});
