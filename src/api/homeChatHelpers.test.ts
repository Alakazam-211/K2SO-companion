import { describe, expect, it } from "vitest";
import {
  NONCE_MAX,
  TYPING_CLEAR_MS,
  TYPING_SEND_INTERVAL_MS,
  applyReactionFrame,
  isOptimistic,
  isValidNonce,
  markDeleted,
  mergeHomeChatMessages,
  newNonce,
  nonceForSend,
  optimisticMessage,
  toggleReaction,
  typingCleared,
  typingForget,
  typingLine,
  typingMembers,
  typingNextExpiry,
  typingNoted,
  typingPruned,
  typingTick,
  type TypingRoster,
  type TypingSent,
} from "./homeChatHelpers";
import type { HomeChatMessage } from "./homeChatPure";

const msg = (id: string, over: Partial<HomeChatMessage> = {}): HomeChatMessage => ({
  id,
  conv: "55",
  authorId: "77",
  body: `m${id}`,
  createdAtMs: 1,
  seq: 0,
  reactions: [],
  replyTo: null,
  edited: false,
  editedAtMs: null,
  deleted: false,
  nonce: null,
  call: null,
  ...over,
});

describe("typing throttle: at most one per conversation every 8 s", () => {
  it("sends, holds for 8 s, then sends again", () => {
    expect(TYPING_SEND_INTERVAL_MS).toBe(8_000);
    let sent: TypingSent = {};
    let t = typingTick(sent, "55", "h", 1_000);
    expect(t.send).toBe(true);
    sent = t.sent;
    for (const at of [1_001, 5_000, 8_999]) {
      t = typingTick(sent, "55", "hi", at);
      expect(t.send).toBe(false);
      expect(t.sent).toBe(sent);
    }
    t = typingTick(sent, "55", "hi!", 9_000);
    expect(t.send).toBe(true);
    expect(t.sent["55"]).toBe(9_000);
  });

  it("each conversation has its own clock; blank drafts never send", () => {
    let sent: TypingSent = typingTick({}, "55", "a", 0).sent;
    expect(typingTick(sent, "56", "a", 1).send).toBe(true);
    expect(typingTick(sent, "55", "   ", 9_000).send).toBe(false);
    expect(typingTick(sent, "", "a", 9_000).send).toBe(false);
    // A send clears the clock: the next keystroke may say typing at once.
    sent = typingForget(sent, "55");
    expect(typingTick(sent, "55", "a", 2).send).toBe(true);
    expect(typingForget(sent, "nope")).toBe(sent);
  });

  it("a clock that went backwards doesn't hold typing for good", () => {
    const sent = typingTick({}, "55", "a", 50_000).sent;
    expect(typingTick(sent, "55", "a", 10_000).send).toBe(true);
  });
});

describe("typing names clear after 10 s, or on their message", () => {
  it("notes, lists, expires", () => {
    expect(TYPING_CLEAR_MS).toBe(10_000);
    let r: TypingRoster = {};
    r = typingNoted(r, "a", 0);
    r = typingNoted(r, "b", 3_000);
    expect(typingMembers(r, 5_000)).toEqual(["a", "b"]);
    expect(typingNextExpiry(r, 5_000)).toBe(10_000);
    expect(typingMembers(r, 10_000)).toEqual(["b"]);
    expect(typingMembers(r, 13_000)).toEqual([]);
    // A new frame pushes the clear time out.
    r = typingNoted(r, "a", 9_000);
    expect(typingMembers(r, 15_000)).toEqual(["a"]);
    expect(typingNextExpiry(r, 30_000)).toBeNull();
  });

  it("their message clears them at once; the viewer is never listed", () => {
    let r: TypingRoster = typingNoted(typingNoted({}, "a", 0), "me", 0);
    expect(typingMembers(r, 1, "me")).toEqual(["a"]);
    r = typingCleared(r, "a");
    expect(typingMembers(r, 1, "me")).toEqual([]);
    expect(typingCleared(r, "zz")).toBe(r);
    expect(typingNoted(r, "", 0)).toBe(r);
  });

  it("prune drops expired names and keeps the object when nothing changed", () => {
    const r = typingNoted(typingNoted({}, "a", 0), "b", 5_000);
    expect(typingPruned(r, 1)).toBe(r);
    expect(typingPruned(r, 10_000)).toEqual({ b: 15_000 });
  });

  it("the line", () => {
    expect(typingLine([])).toBe("");
    expect(typingLine(["Alex"])).toBe("Alex is typing…");
    expect(typingLine(["Alex", "Sam"])).toBe("Alex and Sam are typing…");
    expect(typingLine(["Alex", "Sam", "Kim"])).toBe("Alex and 2 others are typing…");
  });
});

describe("send with a nonce", () => {
  it("a fresh nonce is 1–64 characters and unique", () => {
    const a = newNonce();
    const b = newNonce();
    expect(isValidNonce(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isValidNonce("")).toBe(false);
    expect(isValidNonce("x".repeat(NONCE_MAX + 1))).toBe(false);
    expect(isValidNonce(5)).toBe(false);
  });

  it("a retry of the same words reuses the nonce; anything else gets a new one", () => {
    let n = 0;
    const make = () => `n${++n}`;
    const first = nonceForSend(null, { conv: "55", text: "hello" }, make);
    expect(first).toEqual({ conv: "55", text: "hello", replyTo: null, nonce: "n1" });
    expect(nonceForSend(first, { conv: "55", text: "hello" }, make)).toBe(first);
    expect(nonceForSend(first, { conv: "55", text: "hello!" }, make).nonce).toBe("n2");
    expect(nonceForSend(first, { conv: "56", text: "hello" }, make).nonce).toBe("n3");
    // A reply to another message is a different send.
    expect(nonceForSend(first, { conv: "55", text: "hello", replyTo: "9" }, make).nonce).toBe("n4");
  });

  it("an over-long maker is trimmed to 64", () => {
    const p = nonceForSend(null, { conv: "1", text: "a" }, () => "y".repeat(100));
    expect(p.nonce).toHaveLength(64);
  });

  it("the server's message replaces the optimistic copy by nonce", () => {
    const pending = nonceForSend(null, { conv: "55", text: "hey" }, () => "abc");
    const opt = optimisticMessage(pending, "77", 5);
    expect(isOptimistic(opt)).toBe(true);
    let list = mergeHomeChatMessages([msg("10")], [opt]);
    expect(list.map((m) => m.id)).toEqual(["10", "~abc"]);
    list = mergeHomeChatMessages(list, [msg("11", { nonce: "abc", body: "hey" })]);
    expect(list.map((m) => m.id)).toEqual(["10", "11"]);
  });
});

describe("merging and frames", () => {
  it("merges by id (later copy wins), oldest first numerically", () => {
    const out = mergeHomeChatMessages([msg("100"), msg("9")], [msg("1000"), msg("100", { body: "edited" })]);
    expect(out.map((m) => m.id)).toEqual(["9", "100", "1000"]);
    expect(out[1].body).toBe("edited");
    const same = [msg("1")];
    expect(mergeHomeChatMessages(same, [])).toBe(same);
  });

  it("reaction frames set the count; `me` moves only for mine; 0 drops it", () => {
    let list = [msg("1", { reactions: [{ emoji: "👍", count: 1, me: true }] })];
    list = applyReactionFrame(list, { msg: "1", emoji: "👍", on: true, count: 2, mine: false });
    expect(list[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    list = applyReactionFrame(list, { msg: "1", emoji: "🎉", on: true, count: 1, mine: true });
    expect(list[0].reactions[1]).toEqual({ emoji: "🎉", count: 1, me: true });
    list = applyReactionFrame(list, { msg: "1", emoji: "👍", on: false, count: 0, mine: true });
    expect(list[0].reactions.map((r) => r.emoji)).toEqual(["🎉"]);
    expect(applyReactionFrame(list, { msg: "nope", emoji: "x", on: true, count: 1, mine: true })).toBe(list);
  });

  it("toggle and delete", () => {
    const list = [msg("1", { reactions: [{ emoji: "👍", count: 1, me: true }] })];
    const off = toggleReaction(list, "1", "👍");
    expect(off.on).toBe(false);
    expect(off.messages[0].reactions).toEqual([]);
    const on = toggleReaction(off.messages, "1", "❤️");
    expect(on.on).toBe(true);
    expect(on.messages[0].reactions).toEqual([{ emoji: "❤️", count: 1, me: true }]);
    const del = markDeleted(on.messages, "1");
    expect(del[0]).toMatchObject({ deleted: true, body: "", reactions: [] });
    expect(markDeleted(del, "nope")).toBe(del);
  });
});
