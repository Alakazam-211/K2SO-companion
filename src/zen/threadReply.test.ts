import { describe, expect, it } from "vitest";
import { formatThreadReply, parseThreadReply, threadReplyHeader, threadReplyQuote, THREAD_REPLY_QUOTE_MAX } from "./threadReply";

const target = { id: "m1", seq: 42, from: "sales", text: "Ship it?\n\nAll green.", part: false };

describe("Thread replies (the desktop's format, K2 0.46.7)", () => {
  it("sends the short marker, the quote as > lines, a blank line, then the words", () => {
    expect(formatThreadReply(target, "  Yes, ship it. ")).toBe("↩ #42 sales:\n> Ship it?\n>\n> All green.\n\nYes, ship it.");
    expect(formatThreadReply(target, "")).toBe("↩ #42 sales:\n> Ship it?\n>\n> All green.");
  });

  it("headers: a part, no seq, no name", () => {
    expect(threadReplyHeader({ seq: 7, from: "a  b", part: true })).toBe("↩ part of #7 a b:");
    expect(threadReplyHeader({ seq: 0, from: " ", part: false })).toBe("↩ someone:");
  });

  it("quotes a whole message up to 600 characters, then cuts with …", () => {
    const long = "x".repeat(THREAD_REPLY_QUOTE_MAX + 5);
    expect(threadReplyQuote({ text: long, part: false })).toBe(`${"x".repeat(THREAD_REPLY_QUOTE_MAX)}…`);
    expect(threadReplyQuote({ text: long, part: true })).toBe(long);
  });

  it("reads a reply back, and the first desktop build's long header too", () => {
    expect(parseThreadReply(formatThreadReply(target, "Yes."))).toEqual({
      part: false,
      seq: 42,
      from: "sales",
      id: "",
      quote: "Ship it?\n\nAll green.",
      rest: "Yes.",
    });
    expect(
      parseThreadReply("Replying to Thread message 9 from sales (id abc-1; read it whole: k2 thread sales --before-seq 10 --limit 1):\n> hi\n\nok")
    ).toMatchObject({ seq: 9, from: "sales", id: "abc-1", quote: "hi", rest: "ok" });
    expect(parseThreadReply("↩ not a reply")).toBeNull();
    expect(parseThreadReply("↩ #1 a:\nno quote")).toBeNull();
    expect(parseThreadReply("hello")).toBeNull();
  });
});
