import { describe, expect, it } from "vitest";
import { isAgentThreadPost, isPersonThreadPost, normaliseThreadItem, stashOfferOf, threadAuthorKind } from "./threadModel";
import { rowLastFromLatest } from "./lastAtFetch";

// K2 0.46.13 thread-author-agent-v1 (K2 m_4xhkftZ9ra; desktop thread-viewer.ts).
describe("whose post is it (K2's author rule)", () => {
  it("an `agent` stamp is the agent's, whatever the via", () => {
    expect(isAgentThreadPost({ author: { kind: "agent", login: "aspen" }, via: "thread" })).toBe(true);
    expect(isAgentThreadPost({ author: { kind: "agent", login: "aspen/side" }, via: "compose" })).toBe(true);
  });

  it("any other stamp is a person's, whatever the via", () => {
    for (const author of [{ kind: "owner" }, { kind: "owner", login: "owner" }, { kind: "user", login: "sam" }, { kind: "guest", login: "g" }, { kind: "imported", login: "x" }]) {
      expect(isPersonThreadPost({ author, via: "thread" })).toBe(true);
    }
  });

  it("no stamp (before 0.46.13): compose is a person's, anything else the agent's", () => {
    expect(isPersonThreadPost({ via: "compose" })).toBe(true);
    expect(isAgentThreadPost({ via: "thread" })).toBe(true);
    expect(isAgentThreadPost({})).toBe(true);
    expect(threadAuthorKind("agent")).toBeNull();
    expect(threadAuthorKind({ kind: "  " })).toBeNull();
  });
});

describe("stash offers follow it", () => {
  const offer = { kind: "stash.offer", stash: { text: "Run the deploy." } };
  it("an agent-stamped offer shows (0.46.13), as does an unstamped agent post", () => {
    expect(stashOfferOf({ ...offer, author: { kind: "agent", login: "aspen" }, via: "thread" })).not.toBeNull();
    expect(stashOfferOf({ ...offer, via: "thread" })).not.toBeNull();
    const m = normaliseThreadItem({ seq: 3, doc: { id: "s1", from: "aspen", body: "fallback", ...offer, author: { kind: "agent", login: "aspen" }, via: "thread" } } as never, "bob");
    expect(m?.stashOffer?.text).toBe("Run the deploy.");
  });

  it("a person's offer is a plain message", () => {
    expect(stashOfferOf({ ...offer, author: { kind: "user", login: "sam" }, via: "thread" })).toBeNull();
    expect(stashOfferOf({ ...offer, via: "compose" })).toBeNull();
  });
});

describe("Home's last-message line", () => {
  const base = { addr: "aspen", at: 1, seq: 5, preview: "hi", kind: "text" };
  it("another person's stamped compose post isn't 'You'", () => {
    expect(rowLastFromLatest({ ...base, from: "sam", via: "compose", author: { kind: "user", login: "sam" } }, "bob")?.mine).toBe(false);
  });
  it("yours stays yours; an unstamped compose row from before 0.46.13 too", () => {
    expect(rowLastFromLatest({ ...base, from: "bob", via: "thread", author: { kind: "user", login: "bob" } }, "bob")?.mine).toBe(true);
    expect(rowLastFromLatest({ ...base, from: "owner", via: "compose" }, "bob")?.mine).toBe(true);
    expect(rowLastFromLatest({ ...base, from: "aspen", via: "thread", author: { kind: "agent", login: "aspen" } }, "bob")?.mine).toBe(false);
  });
});
