// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccessoryBar } from "./AccessoryBar";
import { TERMINAL_ACCESSORY_KEYS } from "../lib/terminalKeys";

afterEach(cleanup);

const keyIds = (bar: HTMLElement) =>
  Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("data-k2-key"));

describe("AccessoryBar zen variant", () => {
  it("renders every key as a glass pill", () => {
    render(<AccessoryBar variant="zen" onKey={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const keys = Array.from(bar.querySelectorAll("button"));
    expect(keys.length).toBe(TERMINAL_ACCESSORY_KEYS.length + 1);
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

  it("puts Return right after Shift+Return and sends a plain CR", () => {
    const onKey = vi.fn();
    render(<AccessoryBar variant="zen" onKey={onKey} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const ids = keyIds(bar);
    expect(ids[ids.indexOf("newline") + 1]).toBe("return");
    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    expect(onKey).toHaveBeenCalledWith("\r", undefined);
    // Shift+Return keeps its own meta-Enter bytes.
    fireEvent.click(screen.getByRole("button", { name: "Shift Enter — newline" }));
    expect(onKey).toHaveBeenLastCalledWith("\x1b\r", undefined);
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
