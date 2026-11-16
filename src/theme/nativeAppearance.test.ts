// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => core);

import { nativeAppearanceAvailable, resetNativeAppearanceForTests, syncNativeAppearance } from "./nativeAppearance";
import { initTheme, nativeLook, paletteBg, SCHEME_KEY, paletteKey } from "./palettes";
import { useThemeStore } from "./themeStore";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

let systemLight = false;
const listeners = new Set<() => void>();

function setUA(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function onIphoneShell() {
  core.isTauri.mockReturnValue(true);
  setUA(IPHONE);
}

function sent() {
  return core.invoke.mock.calls.filter(([cmd]) => cmd === "set_appearance").map(([, args]) => args);
}

beforeEach(() => {
  localStorage.clear();
  resetNativeAppearanceForTests();
  core.invoke.mockReset().mockResolvedValue(true);
  core.isTauri.mockReset().mockReturnValue(false);
  systemLight = false;
  listeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("light") ? systemLight : !systemLight;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  useThemeStore.setState({ mode: "dark", dark: "obsidian", light: "veil", shown: "obsidian" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the native appearance bridge", () => {
  it("is a no-op outside Tauri (tests, the browser)", () => {
    setUA(IPHONE);
    expect(nativeAppearanceAvailable()).toBe(false);
    initTheme();
    useThemeStore.getState().setMode("light");
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("is a no-op on Android (another owner's) and desktop", () => {
    core.isTauri.mockReturnValue(true);
    setUA(ANDROID);
    expect(nativeAppearanceAvailable()).toBe(false);
    initTheme();
    useThemeStore.getState().setMode("light");
    setUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15");
    useThemeStore.getState().setMode("auto");
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("is a no-op when isTauri throws", () => {
    core.isTauri.mockImplementation(() => {
      throw new Error("no bridge");
    });
    setUA(IPHONE);
    expect(nativeAppearanceAvailable()).toBe(false);
  });

  it("initTheme tells native the stored mode with the page colours (default: Dark, Obsidian)", () => {
    onIphoneShell();
    initTheme();
    expect(sent()).toEqual([{ mode: "dark", bg: "#0a0a0a", darkBg: "#0a0a0a", lightBg: "#fafafa" }]);
  });

  it("initTheme sends a stored Light (Veil) and Dusk as the dark side", () => {
    localStorage.setItem(SCHEME_KEY, "light");
    localStorage.setItem(paletteKey("dark"), "yellow");
    onIphoneShell();
    initTheme();
    expect(sent()).toEqual([{ mode: "light", bg: "#fafafa", darkBg: "#100f0e", lightBg: "#fafafa" }]);
  });

  it("Settings → Themes: each mode reaches native with the colour on screen", () => {
    onIphoneShell();
    const store = useThemeStore.getState();
    store.setMode("light");
    store.setMode("dark");
    systemLight = true;
    store.setMode("auto");
    expect(sent()).toEqual([
      { mode: "light", bg: "#fafafa", darkBg: "#0a0a0a", lightBg: "#fafafa" },
      { mode: "dark", bg: "#0a0a0a", darkBg: "#0a0a0a", lightBg: "#fafafa" },
      { mode: "auto", bg: "#fafafa", darkBg: "#0a0a0a", lightBg: "#fafafa" },
    ]);
  });

  it("a palette card sends its side's colour", () => {
    onIphoneShell();
    useThemeStore.getState().pickPalette("yellow");
    expect(sent()).toEqual([{ mode: "dark", bg: "#100f0e", darkBg: "#100f0e", lightBg: "#fafafa" }]);
  });

  it("under Auto, an iPhone appearance change moves the colour behind the page", () => {
    onIphoneShell();
    useThemeStore.getState().setMode("auto");
    expect(sent()[sent().length - 1]).toMatchObject({ mode: "auto", bg: "#0a0a0a" });
    systemLight = true;
    useThemeStore.getState().refresh();
    expect(useThemeStore.getState().shown).toBe("veil");
    expect(sent()[sent().length - 1]).toEqual({ mode: "auto", bg: "#fafafa", darkBg: "#0a0a0a", lightBg: "#fafafa" });
  });

  it("an unchanged look is not sent twice", () => {
    onIphoneShell();
    initTheme();
    initTheme();
    useThemeStore.getState().setMode("dark");
    useThemeStore.getState().refresh();
    expect(sent()).toHaveLength(1);
  });

  it("a failed send (an older shell) is retried on the next sync", async () => {
    onIphoneShell();
    core.invoke.mockRejectedValueOnce(new Error("command set_appearance not found"));
    const look = nativeLook({ mode: "light", dark: "obsidian", light: "veil" }, false);
    syncNativeAppearance(look);
    await Promise.resolve();
    await Promise.resolve();
    syncNativeAppearance(look);
    expect(sent()).toHaveLength(2);
  });

  it("paletteBg is each palette's --color-bg", () => {
    expect(paletteBg("obsidian")).toBe("#0a0a0a");
    expect(paletteBg("veil")).toBe("#fafafa");
    expect(paletteBg("yellow")).toBe("#100f0e");
  });
});
