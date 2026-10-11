// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ELLIPSIS, MIDDLE_TAIL_CHARS, middleEllipsis } from "./nameEllipsis";
import { MiddleEllipsis } from "./MiddleEllipsis";

/** 10px a character: a monospace stand-in for measureText. */
const mono = (s: string) => s.length * 10;

describe("middleEllipsis", () => {
  it("leaves a name that fits alone", () => {
    expect(middleEllipsis("plan.md", 70, mono)).toBe("plan.md");
    expect(middleEllipsis("plan.md", 500, mono)).toBe("plan.md");
  });

  it("cuts the middle and keeps the last 10 characters", () => {
    const name = "very-long-file-name-for-the-header.ts";
    const out = middleEllipsis(name, 240, mono);
    expect(MIDDLE_TAIL_CHARS).toBe(10);
    expect(out.endsWith("-header.ts")).toBe(true);
    expect(out).toBe(`very-long-fil${ELLIPSIS}-header.ts`);
    expect(out.slice(out.indexOf(ELLIPSIS) + 1)).toHaveLength(10);
    expect(mono(out)).toBeLessThanOrEqual(240);
    // As much head as fits: one more character would overflow.
    expect(mono(name.slice(0, 14) + ELLIPSIS + "-header.ts")).toBeGreaterThan(240);
  });

  it("never ends in an ellipsis while the tail fits", () => {
    for (const w of [120, 160, 200, 240]) {
      const out = middleEllipsis("screenshot-2026-10-11-at-09.41.22.png", w, mono);
      expect(out.endsWith(".41.22.png")).toBe(true);
      expect(out).toContain(ELLIPSIS);
      expect(out.endsWith(ELLIPSIS)).toBe(false);
    }
  });

  it("only shrinks the tail when the slot cannot hold … plus 10", () => {
    expect(middleEllipsis("abcdefghijkl.ts", 120, mono)).toBe(`a${ELLIPSIS}fghijkl.ts`);
    expect(middleEllipsis("abcdefghijkl.ts", 100, mono)).toBe(`${ELLIPSIS}ghijkl.ts`);
    expect(middleEllipsis("abcdefghijkl.ts", 50, mono)).toBe(`${ELLIPSIS}l.ts`);
    expect(middleEllipsis("abcdefghijkl.ts", 0, mono)).toBe("");
  });
});

describe("<MiddleEllipsis>", () => {
  afterEach(() => cleanup());

  function withWidth(px: number, run: () => void) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => px });
    try {
      run();
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
    }
  }

  it("renders the middle-cut name for the measured width, full name in title", () => {
    withWidth(120, () => {
      render(<MiddleEllipsis text="quarterly-report-final-v2.xlsx" measure={mono} testId="n" labelled />);
    });
    const el = screen.getByTestId("n");
    expect(el.textContent).toBe(`q${ELLIPSIS}al-v2.xlsx`);
    expect(el.getAttribute("title")).toBe("quarterly-report-final-v2.xlsx");
    expect(el.getAttribute("aria-label")).toBe("quarterly-report-final-v2.xlsx");
    expect(el.className).not.toMatch(/truncate/);
  });

  it("a wide slot shows the whole name", () => {
    withWidth(1000, () => {
      render(<MiddleEllipsis text="quarterly-report-final-v2.xlsx" measure={mono} testId="n" />);
    });
    expect(screen.getByTestId("n").textContent).toBe("quarterly-report-final-v2.xlsx");
  });
});
