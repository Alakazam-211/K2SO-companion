// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { pointOnText } from "./useMessageHold";

afterEach(() => vi.restoreAllMocks());

describe("pointOnText (a press on the words selects; elsewhere holds)", () => {
  it("true on a character's box, false beside it or outside the message", () => {
    const bubble = document.createElement("div");
    bubble.textContent = "Hi";
    document.body.appendChild(bubble);
    const text = bubble.firstChild!;
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range };
    doc.caretRangeFromPoint = (x: number) => {
      const r = document.createRange();
      r.setStart(text, x < 10 ? 0 : 1);
      return r;
    };
    // jsdom has no layout: one 10 px box per character, 20 px tall.
    const had = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const left = this.startOffset * 10;
        return [{ left, right: left + 10, top: 0, bottom: 20 }];
      },
    });
    onTestFinished(() => {
      if (had) Object.defineProperty(Range.prototype, "getClientRects", had);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
    });
    expect(pointOnText(5, 10, bubble)).toBe(true);
    expect(pointOnText(15, 10, bubble)).toBe(true);
    // Beside a short line: the caret clamps to the end, but the point is past it.
    expect(pointOnText(60, 10, bubble)).toBe(false);
    // Below the line (the bubble's padding).
    expect(pointOnText(5, 40, bubble)).toBe(false);
    const other = document.createElement("div");
    expect(pointOnText(5, 10, other)).toBe(false);
    Reflect.deleteProperty(doc, "caretRangeFromPoint");
    bubble.remove();
  });
});
