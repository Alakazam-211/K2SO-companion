import { describe, expect, it } from "vitest";
import { overlayHomePath } from "./overlayHome";

describe("overlayHomePath", () => {
  it("opens the overlay when a server is saved", () => {
    expect(overlayHomePath(true)).toBe("/zen");
  });

  it("opens add-server when none are saved", () => {
    expect(overlayHomePath(false)).toBe("/servers");
  });
});
