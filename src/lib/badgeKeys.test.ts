// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useServersStore } from "../stores/servers";
import {
  __resetBadgeKeysForTests,
  BADGE_KEYS_KEY,
  badgeKeyFromReply,
  badgeKeyOf,
  forgetBadgeKey,
  learnBadgeKey,
  normalizeBadgeKey,
  onBadgeKeyChange,
  readBadgeKeys,
} from "./badgeKeys";

beforeEach(() => {
  localStorage.clear();
  __resetBadgeKeysForTests();
});

describe("badgeKeys", () => {
  it("learns per server, persists, and survives a reload", () => {
    expect(badgeKeyOf("s1")).toBeNull();
    expect(learnBadgeKey("s1", "bk_Owner-1")).toBe(true);
    expect(learnBadgeKey("s2", " bk2 ")).toBe(true);
    expect(badgeKeyOf("s1")).toBe("bk_Owner-1");
    expect(JSON.parse(localStorage.getItem(BADGE_KEYS_KEY)!)).toEqual({ s1: "bk_Owner-1", s2: "bk2" });
    __resetBadgeKeysForTests();
    expect(readBadgeKeys()).toEqual({ s1: "bk_Owner-1", s2: "bk2" });
  });

  it("a changed value overwrites; the same value is not a change", () => {
    const seen: [string, string | null, string | null][] = [];
    const off = onBadgeKeyChange((id, next, prev) => seen.push([id, next, prev]));
    learnBadgeKey("s1", "a");
    expect(learnBadgeKey("s1", "a")).toBe(false);
    expect(learnBadgeKey("s1", "b")).toBe(true);
    expect(badgeKeyOf("s1")).toBe("b");
    off();
    expect(seen).toEqual([
      ["s1", "a", null],
      ["s1", "b", "a"],
    ]);
  });

  it("ignores missing or unusable values (keeps what it had)", () => {
    learnBadgeKey("s1", "keep");
    for (const bad of [undefined, null, "", "  ", 42, "has space", "x".repeat(129), "é"]) {
      expect(learnBadgeKey("s1", bad)).toBe(false);
    }
    expect(badgeKeyOf("s1")).toBe("keep");
    expect(normalizeBadgeKey("AbC+/=._~:-9")).toBe("AbC+/=._~:-9");
  });

  it("is cleared when the server is forgotten", () => {
    learnBadgeKey("s1", "a");
    learnBadgeKey("s2", "b");
    forgetBadgeKey("s1");
    expect(readBadgeKeys()).toEqual({ s2: "b" });
    // Via the servers store's forget hook (remove).
    useServersStore.setState({
      servers: [{ id: "s2", nickname: "", url: "https://x.k2.dev", username: "u", rememberPassword: false }],
      tokens: {},
      activeServerId: null,
      recovery: {},
    });
    useServersStore.getState().removeServer("s2");
    expect(readBadgeKeys()).toEqual({});
    expect(JSON.parse(localStorage.getItem(BADGE_KEYS_KEY)!)).toEqual({});
  });

  it("a corrupt stored value reads as empty", () => {
    localStorage.setItem(BADGE_KEYS_KEY, "{oops");
    __resetBadgeKeysForTests();
    expect(readBadgeKeys()).toEqual({});
    localStorage.setItem(BADGE_KEYS_KEY, '{"s1":7,"s2":"ok"}');
    __resetBadgeKeysForTests();
    expect(readBadgeKeys()).toEqual({ s2: "ok" });
  });

  it("reads the key out of a reply body", () => {
    expect(badgeKeyFromReply('{"ok":true,"badgeKey":"bk1"}')).toBe("bk1");
    expect(badgeKeyFromReply({ badgeKey: "bk2" })).toBe("bk2");
    expect(badgeKeyFromReply('{"ok":true}')).toBeNull();
    expect(badgeKeyFromReply("nope")).toBeNull();
    expect(badgeKeyFromReply("")).toBeNull();
  });
});
