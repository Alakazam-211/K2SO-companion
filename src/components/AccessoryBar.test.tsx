// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccessoryBar, ZEN_HIDE_PILL_WIDTH, ZEN_STRIP_END_PAD } from "./AccessoryBar";
import { TERMINAL_ACCESSORY_KEYS } from "../lib/terminalKeys";

afterEach(cleanup);

const keyIds = (bar: HTMLElement) =>
  Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("data-k2-key"));

describe("AccessoryBar zen variant", () => {
  it("renders every key as a glass pill", () => {
    render(<AccessoryBar variant="zen" onKey={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const keys = Array.from(bar.querySelectorAll("button"));
    expect(keys.length).toBe(TERMINAL_ACCESSORY_KEYS.length);
    for (const k of keys) {
      expect(k.className).toMatch(/\bzen-glass\b/);
      expect(k.className).toMatch(/\bzen-glass-pill\b/);
      expect(k.style.height).toBe("32px");
    }
  });

  it("has no outline, border, fill or glass casing around the row", () => {
    render(<AccessoryBar variant="zen" onKey={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const row = bar.parentElement as HTMLElement;
    expect(row.getAttribute("data-k2")).toBe("accessory-row");
    for (const el of [row, bar]) {
      expect(el.className).not.toMatch(/zen-glass|k2-tile|border|outline|shadow|bg-|ring/);
      expect(el.style.border).toBe("");
      expect(el.style.boxShadow).toBe("");
      expect(el.style.background).toBe("");
    }
    // The strip still scrolls horizontally rather than dropping keys.
    expect(bar.style.overflowX).toBe("auto");
  });

  it("has no Return key; Shift+Return keeps its own bytes", () => {
    const onKey = vi.fn();
    render(<AccessoryBar variant="zen" onKey={onKey} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(keyIds(bar)).toEqual(TERMINAL_ACCESSORY_KEYS.map((k) => k.id));
    expect(keyIds(bar)).not.toContain("return");
    expect(screen.queryByRole("button", { name: "Return" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Shift Enter — newline" }));
    expect(onKey).toHaveBeenLastCalledWith("\x1b\r", undefined);
  });

  it("pads the strip's right end so the last key scrolls clear of the pill", () => {
    render(<AccessoryBar variant="zen" onKey={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(ZEN_STRIP_END_PAD).toBeGreaterThan(ZEN_HIDE_PILL_WIDTH);
    expect(bar.style.paddingRight).toBe(`${ZEN_STRIP_END_PAD}px`);
    expect(bar.className).not.toMatch(/\bpr-/);
  });

  it("puts a right-to-left progressive blur behind the pill that never takes touches", () => {
    render(<AccessoryBar variant="zen" onKey={() => {}} />);
    const row = screen.getByRole("toolbar", { name: "Terminal keys" }).parentElement as HTMLElement;
    const blur = row.querySelector('[data-k2="hide-keyboard-blur"]') as HTMLElement;
    expect(blur).not.toBeNull();
    expect(blur.className).toMatch(/\bzen-edge-blur\b/);
    expect(blur.className).toMatch(/\bzen-edge-blur--to-left\b/);
    expect(blur.getAttribute("aria-hidden")).toBe("true");
    expect(blur.style.pointerEvents).toBe("none");
    // Covers the pill and reaches over the keys to its left.
    const width = parseFloat(blur.style.width);
    expect(width - ZEN_HIDE_PILL_WIDTH).toBeGreaterThanOrEqual(40);
    expect(width - ZEN_HIDE_PILL_WIDTH).toBeLessThanOrEqual(56);
    for (const n of [1, 2, 3, 4]) expect(blur.querySelector(`.zen-edge-blur-${n}`)).not.toBeNull();
    expect(blur.querySelector(".zen-edge-blur-tint")).not.toBeNull();
    // Stacked between the strip and the pill.
    const hide = screen.getByRole("button", { name: "Hide keyboard" });
    expect(blur.nextElementSibling).toBe(hide);
    expect(hide.style.position).toBe("absolute");
    expect(hide.style.right).toBe("0px");
    expect(hide.style.width).toBe(`${ZEN_HIDE_PILL_WIDTH}px`);
  });

  it("pins a hide-keyboard pill at the right end that blurs the focused input", () => {
    render(
      <>
        <input data-testid="capture" />
        <AccessoryBar variant="zen" onKey={() => {}} />
      </>
    );
    const capture = screen.getByTestId("capture") as HTMLInputElement;
    capture.focus();
    expect(document.activeElement).toBe(capture);
    const hide = screen.getByRole("button", { name: "Hide keyboard" });
    const row = screen.getByRole("toolbar", { name: "Terminal keys" }).parentElement as HTMLElement;
    expect(row.lastElementChild).toBe(hide);
    expect(hide.className).toMatch(/\bzen-glass\b/);
    expect(hide.querySelector("svg")).not.toBeNull();
    fireEvent.click(hide);
    expect(document.activeElement).not.toBe(capture);
  });
});

describe("AccessoryBar default variant is unchanged", () => {
  it("keeps the classic keys, chrome and sizes", () => {
    const onKey = vi.fn();
    const { container } = render(<AccessoryBar onKey={onKey} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(container.firstElementChild).toBe(bar);
    expect(bar.className).toBe("flex gap-1.5 pb-2 -mx-4 px-4");
    expect(keyIds(bar)).toEqual(TERMINAL_ACCESSORY_KEYS.map((k) => k.id));
    expect(screen.queryByRole("button", { name: "Return" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide keyboard" })).toBeNull();
    for (const k of Array.from(bar.querySelectorAll("button"))) {
      expect(k.className).toBe(
        "border border-[var(--accent-dim)] bg-[var(--background)] text-[var(--text)] text-[12px] shrink-0"
      );
      expect(k.style.minWidth).toBe("44px");
      expect(k.style.height).toBe("44px");
    }
    fireEvent.click(screen.getByRole("button", { name: "Escape" }));
    expect(onKey).toHaveBeenCalledWith("\x1b", undefined);
  });
});
