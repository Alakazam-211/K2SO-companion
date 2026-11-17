import { describe, expect, it } from "vitest";
import {
  isTypingFrame,
  parseThreadTypingFrame,
  postEndsTyping,
  threadPostAuthor,
  threadTypingTick,
  typingFrameForThread,
  THREAD_TYPING_SEND_MS,
  threadTypingLine,
  typingOldestFirst,
} from "./threadTyping";
import { typingLine } from "../api/homeChatHelpers";
import { isThreadFrame } from "./threadTurn";
import { typingWords } from "./homeChat/HomeChatTyping";

const frame = { collection: "typing", seq: 0, id: "aspen", member: "mira", name: "Mira", kind: "person", at: 5 };

describe("thread typing frames", () => {
  it("parses the daemon's frame; never a message", () => {
    expect(isTypingFrame(frame)).toBe(true);
    expect(isThreadFrame(frame)).toBe(false);
    expect(parseThreadTypingFrame(frame)).toEqual({ thread: "aspen", member: "mira", name: "Mira", kind: "person", at: 5 });
    expect(parseThreadTypingFrame({ ...frame, member: "" })).toBeNull();
    expect(parseThreadTypingFrame({ ...frame, collection: "thread" })).toBeNull();
    expect(parseThreadTypingFrame(null)).toBeNull();
  });

  it("is for this Thread by addr (case aside); no id or no addr yet → taken", () => {
    const f = parseThreadTypingFrame(frame)!;
    expect(typingFrameForThread(f, "aspen")).toBe(true);
    expect(typingFrameForThread(f, "ASPEN")).toBe(true);
    expect(typingFrameForThread(f, "other")).toBe(false);
    expect(typingFrameForThread({ ...f, thread: "" }, "other")).toBe(true);
    expect(typingFrameForThread(f, "")).toBe(true);
  });
});

describe("a post ends its author's typing", () => {
  it("by the author stamp's login (or kind:login), else the shown name", () => {
    const a = threadPostAuthor({ id: "m", seq: 3, doc: { from: "Mira Diaz", body: "hi", author: { kind: "user", login: "mira" } } })!;
    expect(a).toEqual({ login: "mira", kind: "user", from: "Mira Diaz" });
    expect(postEndsTyping(a, "mira", "Mira")).toBe(true);
    expect(postEndsTyping(a, "user:mira", "Mira")).toBe(true);
    expect(postEndsTyping(a, "ben", "Ben")).toBe(false);
    // No stamp (an older daemon): the name.
    const old = threadPostAuthor({ doc: { from: "Mira", body: "hi" } })!;
    expect(postEndsTyping(old, "m-17", "Mira")).toBe(true);
    expect(postEndsTyping(old, "m-18", "Ben")).toBe(false);
  });

  it("an agent's post never clears a person; a tombstone posts nothing", () => {
    const agent = threadPostAuthor({ doc: { from: "Mira", body: "x", author: { kind: "agent", login: "mira" } } })!;
    expect(postEndsTyping(agent, "mira", "Mira")).toBe(false);
    expect(threadPostAuthor({ doc: { from: "Mira", deleted: true } })).toBeNull();
  });
});

describe("sending typing", () => {
  it("at most once per 8 s per Thread, only with words", () => {
    expect(THREAD_TYPING_SEND_MS).toBe(8000);
    let sent = {};
    const tick = (text: string, now: number) => {
      const r = threadTypingTick(sent, "aspen", text, now);
      sent = r.sent;
      return r.send;
    };
    expect(tick("", 0)).toBe(false);
    expect(tick("  ", 0)).toBe(false);
    expect(tick("h", 1000)).toBe(true);
    expect(tick("he", 1500)).toBe(false);
    expect(tick("hel", 1000 + THREAD_TYPING_SEND_MS - 1)).toBe(false);
    expect(tick("hell", 1000 + THREAD_TYPING_SEND_MS)).toBe(true);
    expect(threadTypingTick(sent, "", "words", 99_000).send).toBe(false);
  });
});

describe("the Thread's words", () => {
  it("one, two, then Several people; the ellipsis is the dots", () => {
    expect(threadTypingLine([])).toBe("");
    expect(threadTypingLine(["Mira"])).toBe("Mira is typing…");
    expect(threadTypingLine(["Mira", "Ben"])).toBe("Mira and Ben are typing…");
    expect(threadTypingLine(["Mira", "Ben", "Ada"])).toBe("Several people are typing…");
    expect(typingWords(["Mira"], threadTypingLine)).toBe("Mira is typing");
    expect(typingWords(["Mira", "Ben", "Ada", "Kai"], threadTypingLine)).toBe("Several people are typing");
  });

  it("Home chat keeps its own words", () => {
    expect(typingWords(["Mira", "Ben", "Ada"])).toBe("Mira and 2 others are typing");
    expect(typingWords(["Mira", "Ben", "Ada"], typingLine)).toBe("Mira and 2 others are typing");
  });
});

describe("oldest first", () => {
  it("by when each run began, not the latest frame", () => {
    const roster = { ben: 20_000, mira: 25_000, ada: 22_000 };
    const since = new Map([
      ["mira", 1000],
      ["ben", 2000],
      ["ada", 3000],
    ]);
    expect(typingOldestFirst(roster, since, 10_000)).toEqual(["mira", "ben", "ada"]);
    expect(typingOldestFirst(roster, since, 21_000)).toEqual(["mira", "ada"]);
  });
});
