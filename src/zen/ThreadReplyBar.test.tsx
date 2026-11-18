// @vitest-environment jsdom
// The Thread's reply bar, as K2 desktop's (570a5a2ea0): on the activity
// ear's own edges, the Jump to bottom pill's glass, "Replying to <name>:"
// and the quoted first line in whole words, and a named × whose tap target
// is finger-sized though it looks 24px.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  REPLY_CANCEL_HIT_PX,
  REPLY_CANCEL_PX,
  THREAD_REPLY_BAR_GAP,
  THREAD_REPLY_BAR_H,
  ThreadReplyBar,
  fitReplyWords,
} from "./ThreadReplyBar";
import { COMPOSER_DRAWER_INSET_PX } from "./GlassComposer";
import { JUMP_PILL_FILL } from "./JumpPill";
import type { ThreadReplyTarget } from "./threadReply";

afterEach(cleanup);

const TARGET: ThreadReplyTarget = {
  id: "m42",
  seq: 42,
  from: "sales",
  text: "Ship the release notes today\nand the rest tomorrow.",
  part: false,
};

function mount(target: ThreadReplyTarget = TARGET) {
  const onCancel = vi.fn();
  render(<ThreadReplyBar target={target} onCancel={onCancel} />);
  const bar = screen.getByTestId("reply-chip");
  return { bar, onCancel, row: screen.getByTestId("reply-row") };
}

describe("reply bar: words", () => {
  it('"Replying to <name>:" in bold, the first line, and a named ×', () => {
    const { bar } = mount();
    const who = bar.querySelector("[data-reply-chip-who]")!;
    expect(who.textContent).toBe("Replying to sales:");
    expect(who.className).toContain("font-semibold");
    expect(bar.querySelector("[data-reply-chip-text]")!.textContent).toBe("Ship the release notes today");
    expect(bar.getAttribute("role")).toBe("note");
    expect(bar.getAttribute("aria-label")).toBe("Replying to sales: Ship the release notes today");
    const x = screen.getByRole("button", { name: "Cancel the reply" });
    expect(x).toBe(bar.querySelector("[data-testid=reply-chip-cancel]"));
    // The reply glyph leads.
    expect(bar.firstElementChild!.tagName.toLowerCase()).toBe("svg");
  });

  it("a reply to a selection says so; a nameless one says someone", () => {
    mount({ ...TARGET, part: true, text: "the rest tomorrow" });
    expect(screen.getByTestId("reply-chip").querySelector("[data-reply-chip-who]")!.textContent).toBe(
      "Replying to part of sales:"
    );
    cleanup();
    mount({ ...TARGET, from: "  " });
    expect(screen.getByTestId("reply-chip").querySelector("[data-reply-chip-who]")!.textContent).toBe(
      "Replying to someone:"
    );
  });

  it("the first line fits in whole words: the tail goes as a whole phrase, then …", () => {
    const w = (s: string): number => s.length * 7;
    const line = "Ship the release notes today and the rest tomorrow";
    expect(fitReplyWords(line, w(line), w)).toBe(line);
    expect(fitReplyWords(line, 23 * 7 + 3, w)).toBe("Ship the release notes…");
    // Never a cut word, even with room for half of the next one.
    expect(fitReplyWords(line, 26 * 7, w)).toBe("Ship the release notes…");
    // A trailing comma goes with the cut.
    expect(fitReplyWords("Yes, ship it today", 5 * 7, w)).toBe("Yes…");
    // Not even the first word: the ellipsis alone.
    expect(fitReplyWords(line, 3 * 7, w)).toBe("…");
    // Unmeasured (no room known yet): the whole line.
    expect(fitReplyWords(line, 0, w)).toBe(line);
  });
});

describe("reply bar: cancel", () => {
  it("× cancels, and keeps the keyboard up (no blur on press)", () => {
    const { onCancel } = mount();
    const x = screen.getByRole("button", { name: "Cancel the reply" });
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    x.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(x);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc cancels (a hardware keyboard)", () => {
    const { onCancel } = mount();
    const x = screen.getByRole("button", { name: "Cancel the reply" });
    x.focus();
    fireEvent.keyDown(x, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("× looks 24px but its tap target is 44 × 44, without growing the 32px bar", () => {
    mount();
    const x = screen.getByRole("button", { name: "Cancel the reply" });
    expect(REPLY_CANCEL_PX).toBe(24);
    expect(REPLY_CANCEL_HIT_PX).toBe(44);
    expect(x.style.width).toBe("44px");
    expect(x.style.height).toBe("44px");
    // 44 − 2·10 = 24 wide in the row; 44 − 2·6 = 32 tall, the bar's height.
    expect(x.style.margin).toBe("-6px -10px");
    const glyph = x.querySelector(".zen-reply-cancel-x") as HTMLElement;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.style.width).toBe("24px");
    expect(glyph.textContent).toBe("×");
  });
});

describe("reply bar: on the ear", () => {
  it("stands on the activity ear's edges, the pill's gap above it", () => {
    const { row } = mount();
    expect(COMPOSER_DRAWER_INSET_PX).toBe(10);
    expect(THREAD_REPLY_BAR_GAP).toBe(8);
    expect(row.style.margin).toBe(`0px ${COMPOSER_DRAWER_INSET_PX}px ${THREAD_REPLY_BAR_GAP}px`);
  });
});

describe("reply bar: the pill's glass", () => {
  it("the Jump to bottom pill's classes, fill, height, padding and type; every word in its ink", () => {
    const { bar } = mount();
    for (const c of ["zen-glass", "zen-glass-pill", "zen-jump-pill", "zen-reply-bar", "text-[13px]"]) {
      expect(bar.classList.contains(c)).toBe(true);
    }
    expect(bar.style.getPropertyValue("background-color")).toBe(JUMP_PILL_FILL.backgroundColor);
    expect(bar.style.getPropertyValue("background-image")).toBe(JUMP_PILL_FILL.backgroundImage);
    expect(bar.style.getPropertyValue("color")).toBe(JUMP_PILL_FILL.color);
    expect(THREAD_REPLY_BAR_H).toBe(32);
    expect(bar.style.minHeight).toBe("32px");
    expect(bar.style.padding).toBe("0px 4px 0px 14px");
    // No muted grey anywhere inside: the words and × take the pill's ink.
    for (const el of Array.from(bar.querySelectorAll<HTMLElement>("*"))) {
      expect(el.getAttribute("style") ?? "").not.toContain("text-muted");
      expect(el.className.toString()).not.toContain("text-muted");
    }
    const x = screen.getByRole("button", { name: "Cancel the reply" });
    expect(x.style.color).toBe("inherit");
  });

  it("index.css: reduced transparency drops the blur for the solid tile", async () => {
    // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
    const { readFileSync } = await import("fs");
    const css = readFileSync("src/styles/index.css", "utf8") as string;
    const at = css.indexOf("  .zen-glass.zen-reply-bar {");
    expect(at).toBeGreaterThan(-1);
    const media = css.lastIndexOf("@media", at);
    expect(css.slice(media, at)).toContain("@media (prefers-reduced-transparency: reduce) {");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("backdrop-filter: none;");
    expect(rule).toContain("background: var(--tile-fill) !important;");
    expect(rule).toContain("border-color: var(--color-border);");
    expect(rule).toContain("color: var(--color-text-primary) !important;");
  });
});
