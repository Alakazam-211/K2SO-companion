import { describe, expect, it } from "vitest";
import { displayAuthor, isMyAuthor, type SessionIdentity } from "./sessionAuthor";

describe("isMyAuthor", () => {
  const owner: SessionIdentity = { username: "riley", owner: true };
  const jane: SessionIdentity = { username: "jane", owner: false };

  it("owner token owns 'owner' rows and its linked username's (K2 0.46.0 stamp)", () => {
    expect(isMyAuthor("owner", owner)).toBe(true);
    expect(isMyAuthor("riley", owner)).toBe(true);
    expect(isMyAuthor("jane", owner)).toBe(false);
    expect(isMyAuthor("scribe", owner)).toBe(false);
  });

  it("connect user owns their username, not the host owner row", () => {
    expect(isMyAuthor("jane", jane)).toBe(true);
    expect(isMyAuthor("owner", jane)).toBe(false);
    expect(isMyAuthor("scribe", jane)).toBe(false);
  });

  it("unknown identity falls back to author === owner", () => {
    expect(isMyAuthor("owner", null)).toBe(true);
    expect(isMyAuthor("jane", null)).toBe(false);
  });
});

describe("displayAuthor", () => {
  it("renders You for mine, the stored name otherwise", () => {
    const jane: SessionIdentity = { username: "jane", owner: false };
    expect(displayAuthor("jane", jane)).toBe("You");
    expect(displayAuthor("owner", jane)).toBe("owner");
    expect(displayAuthor("scribe", jane)).toBe("scribe");
  });
});
