// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JUMP_PILL_DARK, JUMP_PILL_FILL, JumpPill, jumpPillText } from "./JumpPill";

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

  it("is the glass tint over a 60% dark layer, on the button itself, through the palette's --jump-pill-*", () => {
    render(<JumpPill words="jump" leaving={false} onJump={() => {}} />);
    const pill = screen.getByTestId("thread-new-message");
    expect(JUMP_PILL_DARK).toEqual({ tint: "rgba(255, 255, 255, 0.1)", scrim: "rgba(0, 0, 0, 0.6)" });
    expect(JUMP_PILL_FILL.backgroundColor).toBe("var(--jump-pill-scrim, rgba(0, 0, 0, 0.6))");
    expect(JUMP_PILL_FILL.backgroundImage).toBe(
      "linear-gradient(var(--jump-pill-tint, rgba(255, 255, 255, 0.1)), var(--jump-pill-tint, rgba(255, 255, 255, 0.1)))"
    );
    expect(pill.style.getPropertyValue("background-color")).toBe(JUMP_PILL_FILL.backgroundColor);
    expect(pill.style.getPropertyValue("color")).toBe(JUMP_PILL_FILL.color);
    expect(pill.className).toContain("zen-jump-pill");
  });

  it("index.css: dark keeps the 60% layer and white words; light is Veil's Frost, no layer, dark words, a 45% rim", async () => {
    // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
    const { readFileSync } = await import("fs");
    const css = readFileSync("src/styles/index.css", "utf8") as string;
    const at = css.indexOf("--jump-pill-tint:");
    const dark = css.slice(at, css.indexOf("}", at));
    expect(dark).toContain("--jump-pill-tint: var(--color-frost-fill);");
    expect(dark).toContain(`--jump-pill-scrim: ${JUMP_PILL_DARK.scrim};`);
    expect(dark).toContain("--jump-pill-ink: #ffffff;");
    const lightAt = css.indexOf('[data-scheme="light"] {\n  --jump-pill-scrim');
    expect(lightAt).toBeGreaterThan(at);
    const light = css.slice(lightAt, css.indexOf("}", lightAt));
    expect(light).toContain("--jump-pill-scrim: transparent;");
    expect(light).toContain("--jump-pill-edge: rgba(0, 0, 0, 0.45);");
    expect(light).toContain("--jump-pill-ink: var(--color-text-primary);");
    expect(css).toMatch(/\.zen-glass\.zen-jump-pill \{\s*border-color: var\(--jump-pill-edge\);/);
  });

  it("keeps white text readable over your blue bubble and over a white image", () => {
    const blue = [10, 132, 255];
    expect(whiteOn(over(blue, [255, 255, 255], 0.1))).toBeLessThan(3.5); // the plain tint: about 3:1
    expect(whiteOn(pill(blue))).toBeGreaterThan(7);
    expect(whiteOn(pill([255, 255, 255]))).toBeGreaterThan(4.5);
  });
});
