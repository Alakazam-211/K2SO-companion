// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JUMP_PILL_FILL, JumpPill, jumpPillText } from "./JumpPill";

afterEach(cleanup);

describe("JumpPill", () => {
  it("counts from two: N new messages", () => {
    expect(jumpPillText("jump")).toBe("Jump to bottom");
    expect(jumpPillText("message", 1)).toBe("New message");
    expect(jumpPillText("message", 2)).toBe("2 new messages");
    expect(jumpPillText("sent", 5)).toBe("Sent");
  });

  it("says Jump to bottom, swaps its words, and sizes its width to them with a transition", () => {
    const widths: Record<string, number> = { "Jump to bottom ↓": 104, "New message ↓": 92 };
    const spy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return widths[this.textContent ?? ""] ?? 0;
    });
    try {
      const onJump = vi.fn();
      const { rerender } = render(<JumpPill words="jump" leaving={false} onJump={onJump} />);
      const pill = screen.getByTestId("thread-new-message");
      expect(pill.textContent).toBe("Jump to bottom ↓");
      expect(pill.style.width).toBe("132px");
      expect(pill.style.transition).toMatch(/width 220ms/);
      rerender(<JumpPill words="message" leaving={false} onJump={onJump} />);
      expect(pill.textContent).toBe("New message ↓");
      expect(pill.style.width).toBe("120px");
      fireEvent.click(pill);
      expect(onJump).toHaveBeenCalledTimes(1);
      rerender(<JumpPill words="message" leaving onJump={onJump} />);
      expect(pill.getAttribute("data-leaving")).toBe("true");
      expect(pill.style.opacity).toBe("0");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the pill's fill (K2 Design 2026-11-16)", () => {
  // Compose the fill's layers over a background, then WCAG contrast with white text.
  const over = (bg: number[], rgb: number[], a: number) => bg.map((c, i) => c * (1 - a) + rgb[i] * a);
  const lum = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const whiteOn = (bg: number[]) => 1.05 / (lum(bg) + 0.05);
  const pill = (bg: number[]) => over(over(bg, [0, 0, 0], 0.6), [255, 255, 255], 0.1);

  it("is the glass tint over a 60% dark layer, on the button itself", () => {
    render(<JumpPill words="jump" leaving={false} onJump={() => {}} />);
    const style = screen.getByTestId("thread-new-message").style;
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0.6)");
    expect(style.backgroundImage).toContain("rgba(255, 255, 255, 0.1)");
    expect(JUMP_PILL_FILL.backgroundColor).toBe(style.backgroundColor);
  });

  it("keeps white text readable over your blue bubble and over a white image", () => {
    const blue = [10, 132, 255];
    expect(whiteOn(over(blue, [255, 255, 255], 0.1))).toBeLessThan(3.5); // the plain tint: about 3:1
    expect(whiteOn(pill(blue))).toBeGreaterThan(7);
    expect(whiteOn(pill([255, 255, 255]))).toBeGreaterThan(4.5);
  });
});
