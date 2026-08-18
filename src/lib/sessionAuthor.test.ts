import { describe, expect, it } from "vitest";
import { displayAuthor, isMyAuthor, type SessionIdentity } from "./sessionAuthor";

describe("isMyAuthor", () => {
  const owner: SessionIdentity = { username: "rosson", owner: true };
  const julie: SessionIdentity = { username: "julie", owner: false };

  it("owner token only owns 'owner' rows", () => {
    expect(isMyAuthor("owner", owner)).toBe(true);
    expect(isMyAuthor("julie", owner)).toBe(false);
    expect(isMyAuthor("scout", owner)).toBe(false);
  });

  it("connect user owns their username, not the host owner row", () => {
    expect(isMyAuthor("julie", julie)).toBe(true);
    expect(isMyAuthor("owner", julie)).toBe(false);
    expect(isMyAuthor("scout", julie)).toBe(false);
  });

  it("unknown identity falls back to author === owner", () => {
    expect(isMyAuthor("owner", null)).toBe(true);
    expect(isMyAuthor("julie", null)).toBe(false);
  });
});

describe("displayAuthor", () => {
  it("renders You for mine, the stored name otherwise", () => {
    const julie: SessionIdentity = { username: "julie", owner: false };
    expect(displayAuthor("julie", julie)).toBe("You");
    expect(displayAuthor("owner", julie)).toBe("owner");
    expect(displayAuthor("scout", julie)).toBe("scout");
  });
});
