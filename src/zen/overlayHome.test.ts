import { describe, expect, it } from "vitest";
import { overlayHomePath } from "./overlayHome";

describe("overlayHomePath", () => {
  it("a fresh install (nothing stored) still opens the overlay, not /servers or /login", () => {
    expect(overlayHomePath(0)).toBe("/zen");
  });

  it("last stored entry deleted still opens the overlay", () => {
    expect(overlayHomePath(0)).toBe("/zen");
  });

  it("a stored server that is unreachable still opens the overlay", () => {
    expect(overlayHomePath(1)).toBe("/zen");
  });

  it("a stored server whose auth is rejected still opens the overlay", () => {
    expect(overlayHomePath(1)).toBe("/zen");
  });
});
