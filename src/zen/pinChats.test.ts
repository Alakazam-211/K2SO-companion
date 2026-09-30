import { describe, expect, it } from "vitest";
import { dropIsPins, isListPan, pinId, unpinId } from "./pinChats";

describe("pinChats", () => {
  it("pins to the front and de-dupes", () => {
    expect(pinId(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    expect(pinId(["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("unpins", () => {
    expect(unpinId(["a", "b"], "a")).toEqual(["b"]);
    expect(unpinId(["a"], "z")).toEqual(["a"]);
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
});
