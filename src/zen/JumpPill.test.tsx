// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JumpPill, jumpPillText } from "./JumpPill";

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
