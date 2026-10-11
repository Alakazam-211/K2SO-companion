// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zenPage from "../pages/Zen.tsx?raw";
import chatsList from "./ChatsList.tsx?raw";
import threadPane from "./ThreadPane.tsx?raw";
import ticketView from "./TicketView.tsx?raw";
import {
  ZEN_FONT_ATTR,
  ZEN_FONT_STORAGE_KEY,
  applyZenFont,
  initZenFont,
  readZenFont,
  useZenFontStore,
  writeZenFont,
} from "./zenFont";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(ZEN_FONT_ATTR);
  useZenFontStore.setState({ font: "system" });
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
