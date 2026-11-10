import { describe, expect, it } from "vitest";
import { pickGardensServer } from "./gardensScope";

const pw = (id: string) => ({ id });
const paired = (id: string) => ({ id, auth: "paired" as const });

describe("pickGardensServer", () => {
  it("is the paired server Home syncs from", () => {
    expect(pickGardensServer([paired("a"), paired("b")], "b")).toBe("b");
  });

  it("is the first paired server when Home syncs from none, or from a password server", () => {
    expect(pickGardensServer([pw("x"), paired("a"), paired("b")], null)).toBe("a");
    expect(pickGardensServer([pw("x"), paired("a")], "x")).toBe("a");
  });

  it("is nothing when the phone is paired with no server", () => {
    expect(pickGardensServer([pw("x"), pw("y")], "x")).toBeNull();
    expect(pickGardensServer([], null)).toBeNull();
  });
});
