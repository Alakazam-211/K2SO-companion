// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zenPage from "../pages/Zen.tsx?raw";
import chatsList from "./ChatsList.tsx?raw";
import threadPane from "./ThreadPane.tsx?raw";
import ticketView from "./TicketView.tsx?raw";
import ticketBrief from "./TicketBrief.tsx?raw";
import zenSettings from "./ZenSettings.tsx?raw";
import {
  ZEN_FONT_ATTR,
  ZEN_FONT_STORAGE_KEY,
  ZEN_TEXT_SCALE_VAR,
  ZEN_TEXT_SIZE_STORAGE_KEY,
  applyZenFont,
  applyZenTextSize,
  readZenTextSize,
  writeZenTextSize,
  zenTextPx,
  initZenFont,
  readZenFont,
  useZenFontStore,
  writeZenFont,
} from "./zenFont";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(ZEN_FONT_ATTR);
  useZenFontStore.setState({ font: "system", textSize: "default" });
  document.documentElement.style.removeProperty(ZEN_TEXT_SCALE_VAR);
});

afterEach(() => vi.restoreAllMocks());

describe("zenFont", () => {
  it("defaults to system and ignores junk", () => {
    expect(readZenFont()).toBe("system");
    localStorage.setItem(ZEN_FONT_STORAGE_KEY, "comic-sans");
    expect(readZenFont()).toBe("system");
  });

  it("restores a saved Meslo choice on load", () => {
    localStorage.setItem(ZEN_FONT_STORAGE_KEY, "meslo");
    expect(initZenFont()).toBe("meslo");
    expect(document.documentElement.getAttribute(ZEN_FONT_ATTR)).toBe("meslo");
    expect(useZenFontStore.getState().font).toBe("meslo");
  });

  it("setFont persists and applies; system clears the attribute", () => {
    useZenFontStore.getState().setFont("meslo");
    expect(localStorage.getItem(ZEN_FONT_STORAGE_KEY)).toBe("meslo");
    expect(document.documentElement.getAttribute(ZEN_FONT_ATTR)).toBe("meslo");
    useZenFontStore.getState().setFont("system");
    expect(localStorage.getItem(ZEN_FONT_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.hasAttribute(ZEN_FONT_ATTR)).toBe(false);
  });

  it("storage failures fall back to system without throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(readZenFont()).toBe("system");
    expect(() => writeZenFont("meslo")).not.toThrow();
    const el = document.createElement("div");
    applyZenFont("meslo", el);
    expect(el.getAttribute(ZEN_FONT_ATTR)).toBe("meslo");
  });

  it("Zen surfaces use var(--zen-font), not a hardcoded system stack", () => {
    for (const src of [chatsList, threadPane, ticketView]) {
      expect(src).toMatch(/var\(--zen-font\)/);
      expect(src).not.toMatch(/-apple-system/);
    }
    expect(zenPage).toMatch(/zen-font/);
  });
});

describe("zen text size", () => {
  it("defaults to default and ignores junk", () => {
    expect(readZenTextSize()).toBe("default");
    localStorage.setItem(ZEN_TEXT_SIZE_STORAGE_KEY, "huge");
    expect(readZenTextSize()).toBe("default");
  });

  it("restores a saved size on load", () => {
    localStorage.setItem(ZEN_TEXT_SIZE_STORAGE_KEY, "small");
    initZenFont();
    expect(document.documentElement.style.getPropertyValue(ZEN_TEXT_SCALE_VAR)).toBe("0.9");
    expect(useZenFontStore.getState().textSize).toBe("small");
  });

  it("setTextSize persists and applies 0.9 / 1 / 1.15", () => {
    const root = document.documentElement;
    for (const [size, scale] of [
      ["small", "0.9"],
      ["large", "1.15"],
      ["default", "1"],
    ] as const) {
      useZenFontStore.getState().setTextSize(size);
      expect(localStorage.getItem(ZEN_TEXT_SIZE_STORAGE_KEY)).toBe(size);
      expect(root.style.getPropertyValue(ZEN_TEXT_SCALE_VAR)).toBe(scale);
    }
  });

  it("storage failures fall back to default without throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(readZenTextSize()).toBe("default");
    expect(() => writeZenTextSize("large")).not.toThrow();
    const el = document.createElement("div");
    applyZenTextSize("large", el);
    expect(el.style.getPropertyValue(ZEN_TEXT_SCALE_VAR)).toBe("1.15");
  });

  it("zenTextPx scales a px size by the variable", () => {
    expect(zenTextPx(17)).toBe("calc(17px * var(--zen-text-scale, 1))");
  });

  it("content surfaces scale; the settings sheet and terminal do not", async () => {
    for (const src of [threadPane, ticketView, ticketBrief]) {
      expect(src).toMatch(/zenTextPx\(/);
    }
    // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
    const { readFileSync } = await import("fs");
    const fileViewerCss = readFileSync("src/zen/files/fileViewer.css", "utf8") as string;
    expect(fileViewerCss).toMatch(/calc\(15px \* var\(--zen-text-scale, 1\)\)/);
    expect(fileViewerCss).toMatch(/calc\(12px \* var\(--zen-text-scale, 1\)\)/);
    expect(zenSettings).not.toMatch(/zenTextPx|--zen-text-scale/);
  });
});
