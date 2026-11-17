// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => core);

import {
  nativeAppearanceAvailable,
  nativeSystemLight,
  resetNativeAppearanceForTests,
  syncNativeAppearance,
  SYSTEM_SCHEME_KEY,
  type NativeAppearance,
} from "./nativeAppearance";
import {
  initTheme,
  nativeLook,
  paletteBg,
  paletteKey,
  paletteScheme,
  SCHEME_KEY,
  type PaletteId,
  type SchemeMode,
} from "./palettes";
import { useThemeStore, watchSystemScheme } from "./themeStore";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

/** What the web view's media query says (on the phone: native's override). */
let mediaLight = false;
const mediaListeners = new Set<() => void>();
let unwatch: () => void = () => {};

function setUA(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function onIphoneShell() {
  core.isTauri.mockReturnValue(true);
  setUA(IPHONE);
}

function sent(): NativeAppearance[] {
  return core.invoke.mock.calls.filter(([cmd]) => cmd === "set_appearance").map(([, args]) => args);
}

function last(): NativeAppearance {
  const all = sent();
  return all[all.length - 1];
}

/** Native's iPhone report (src-tauri/src/appearance.rs `page_js`). */
function nativeSays(scheme: unknown) {
  window.__k2SystemAppearance?.(scheme as string);
}

/** appearance.rs `Appearance::scheme`: the override native sets for a look
 *  — the scheme of the side on screen. */
function nativeStyle(look: NativeAppearance, iphoneLight: boolean): "light" | "dark" {
  const lightSide = look.mode === "light" || (look.mode === "auto" && iphoneLight);
  return lightSide ? look.lightScheme : look.darkScheme;
}

function pageScheme() {
  return document.documentElement.getAttribute("data-scheme");
}

beforeEach(() => {
  localStorage.clear();
  resetNativeAppearanceForTests();
  core.invoke.mockReset().mockResolvedValue(true);
  core.isTauri.mockReset().mockReturnValue(false);
  mediaLight = false;
  mediaListeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("light") ? mediaLight : !mediaLight;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  useThemeStore.setState({ mode: "dark", dark: "obsidian", light: "veil", shown: "obsidian" });
});

afterEach(() => {
  unwatch();
  unwatch = () => {};
  vi.restoreAllMocks();
});

describe("the native appearance bridge", () => {
  it("is a no-op outside Tauri (tests, the browser)", () => {
    setUA(IPHONE);
    expect(nativeAppearanceAvailable()).toBe(false);
    initTheme();
    useThemeStore.getState().setMode("light");
    expect(core.invoke).not.toHaveBeenCalled();
    expect(window.__k2SystemAppearance).toBeUndefined();
    expect(nativeSystemLight()).toBeNull();
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

  it("initTheme tells native the stored look with the page colours and schemes (default: Auto, Obsidian by day, Dusk at night)", () => {
    onIphoneShell();
    initTheme();
    expect(sent()).toEqual([
      { mode: "auto", bg: "#100f0e", darkBg: "#100f0e", lightBg: "#0a0a0a", darkScheme: "dark", lightScheme: "dark" },
    ]);
  });

  it("initTheme sends a stored Light (Veil) and Dusk as the dark side", () => {
    localStorage.setItem(SCHEME_KEY, "light");
    localStorage.setItem(paletteKey("light"), "veil");
    localStorage.setItem(paletteKey("dark"), "yellow");
    onIphoneShell();
    initTheme();
    expect(sent()).toEqual([
      { mode: "light", bg: "#fafafa", darkBg: "#100f0e", lightBg: "#fafafa", darkScheme: "dark", lightScheme: "light" },
    ]);
  });

  it("Settings → Themes: each mode reaches native with the colour on screen", () => {
    onIphoneShell();
    const store = useThemeStore.getState();
    store.setMode("light");
    store.setMode("dark");
    mediaLight = true; // native hasn't answered yet: the media query stands in
    store.setMode("auto");
    const sides = { darkBg: "#0a0a0a", lightBg: "#fafafa", darkScheme: "dark", lightScheme: "light" };
    expect(sent()).toEqual([
      { mode: "light", bg: "#fafafa", ...sides },
      { mode: "dark", bg: "#0a0a0a", ...sides },
      { mode: "auto", bg: "#fafafa", ...sides },
    ]);
  });

  it("a palette card sends its side's colour and scheme", () => {
    onIphoneShell();
    useThemeStore.getState().pickPalette("dark", "yellow");
    expect(sent()).toEqual([
      { mode: "dark", bg: "#100f0e", darkBg: "#100f0e", lightBg: "#fafafa", darkScheme: "dark", lightScheme: "light" },
    ]);
  });

  it("an unchanged look is not sent twice", () => {
    useThemeStore.setState({ mode: "auto", dark: "yellow", light: "obsidian", shown: "yellow" });
    onIphoneShell();
    initTheme();
    initTheme();
    useThemeStore.getState().setMode("auto");
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

  it("paletteBg and paletteScheme are each palette's --color-bg and scheme", () => {
    expect(paletteBg("obsidian")).toBe("#0a0a0a");
    expect(paletteBg("veil")).toBe("#fafafa");
    expect(paletteBg("yellow")).toBe("#100f0e");
    expect(paletteScheme("obsidian")).toBe("dark");
    expect(paletteScheme("veil")).toBe("light");
    expect(paletteScheme("yellow")).toBe("dark");
  });
});

describe("the keyboard follows the palette on screen (Riley 2026-11-17)", () => {
  it("Obsidian or Dusk for the day side under Light: the keyboard is dark", () => {
    onIphoneShell();
    for (const day of ["obsidian", "yellow"] as const) {
      useThemeStore.getState().pickPalette("light", day);
      expect(last()).toMatchObject({ mode: "light", bg: paletteBg(day), lightBg: paletteBg(day), lightScheme: "dark" });
      expect(nativeStyle(last(), true)).toBe("dark");
      expect(nativeStyle(last(), false)).toBe("dark");
      expect(pageScheme()).toBe("dark");
    }
  });

  it("Obsidian for the day side under Auto, iPhone in Light: the keyboard is dark", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.setState({ mode: "auto", dark: "yellow", light: "obsidian", shown: "yellow" });
    useThemeStore.getState().setMode("auto");
    nativeSays("light");
    expect(useThemeStore.getState().shown).toBe("obsidian");
    expect(last()).toMatchObject({ mode: "auto", bg: "#0a0a0a", lightScheme: "dark", darkScheme: "dark" });
    expect(nativeStyle(last(), true)).toBe("dark");
  });

  it("every mode × night palette × day palette × iPhone appearance: native's style is the page's scheme", () => {
    const ids: PaletteId[] = ["obsidian", "veil", "yellow"];
    const modes: SchemeMode[] = ["light", "dark", "auto"];
    let cases = 0;
    onIphoneShell();
    for (const mode of modes)
      for (const dark of ids)
        for (const light of ids)
          for (const iphoneLight of [true, false]) {
            localStorage.clear();
            resetNativeAppearanceForTests();
            core.invoke.mockClear();
            localStorage.setItem(SCHEME_KEY, mode);
            localStorage.setItem(paletteKey("dark"), dark);
            localStorage.setItem(paletteKey("light"), light);
            // Native's last report, kept from the last launch; the media
            // query (the override) says the opposite and must not count.
            localStorage.setItem(SYSTEM_SCHEME_KEY, iphoneLight ? "light" : "dark");
            mediaLight = !iphoneLight;
            initTheme();
            const shown = mode === "light" ? light : mode === "dark" ? dark : iphoneLight ? light : dark;
            const label = `${mode} night=${dark} day=${light} iphone=${iphoneLight ? "light" : "dark"}`;
            expect(sent(), label).toHaveLength(1);
            expect(last(), label).toEqual({
              mode,
              bg: paletteBg(shown),
              darkBg: paletteBg(dark),
              lightBg: paletteBg(light),
              darkScheme: paletteScheme(dark),
              lightScheme: paletteScheme(light),
            });
            expect(document.documentElement.getAttribute("data-palette"), label).toBe(shown);
            expect(nativeStyle(last(), iphoneLight), label).toBe(paletteScheme(shown));
            expect(pageScheme(), label).toBe(paletteScheme(shown));
            cases++;
          }
    expect(cases).toBe(54);
  });
});

describe("under Auto, the iPhone's appearance comes from native on the phone", () => {
  it("a native report switches the side and re-sends; the media query (the override) is ignored", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.getState().setMode("auto");
    expect(last()).toMatchObject({ mode: "auto", bg: "#0a0a0a" });
    expect(mediaListeners.size).toBe(0);

    mediaLight = false; // the override says dark
    nativeSays("light");
    expect(useThemeStore.getState().shown).toBe("veil");
    expect(last()).toEqual({
      mode: "auto",
      bg: "#fafafa",
      darkBg: "#0a0a0a",
      lightBg: "#fafafa",
      darkScheme: "dark",
      lightScheme: "light",
    });

    mediaLight = true;
    nativeSays("dark");
    expect(useThemeStore.getState().shown).toBe("obsidian");
    expect(last()).toMatchObject({ mode: "auto", bg: "#0a0a0a" });
    expect(sent()).toHaveLength(3);
  });

  it("the same report again (native re-tells after every set_appearance) sends nothing", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.getState().setMode("auto");
    nativeSays("light");
    const n = sent().length;
    nativeSays("light");
    nativeSays("light");
    expect(sent()).toHaveLength(n);
  });

  it("a report under Light or Dark changes nothing on screen and sends nothing", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.getState().setMode("light");
    const n = sent().length;
    nativeSays("dark");
    nativeSays("light");
    expect(useThemeStore.getState().shown).toBe("veil");
    expect(sent()).toHaveLength(n);
  });

  it("junk reports are ignored", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.getState().setMode("auto");
    const n = sent().length;
    for (const junk of ["auto", "Light", "", 1, undefined, null]) nativeSays(junk);
    expect(nativeSystemLight()).toBeNull();
    expect(localStorage.getItem(SYSTEM_SCHEME_KEY)).toBeNull();
    expect(sent()).toHaveLength(n);
  });

  it("the last report is kept for the next launch's first paint", () => {
    onIphoneShell();
    unwatch = watchSystemScheme();
    useThemeStore.getState().setMode("auto");
    nativeSays("light");
    expect(localStorage.getItem(SYSTEM_SCHEME_KEY)).toBe("light");
    // Next launch: module state gone, the device keeps the report, and the
    // override (saved natively) makes the media query say dark.
    resetNativeAppearanceForTests();
    mediaLight = false;
    expect(nativeSystemLight()).toBe(true);
    initTheme();
    expect(document.documentElement.getAttribute("data-palette")).toBe("veil");
  });

  it("before native has ever answered, the media query stands in", () => {
    onIphoneShell();
    mediaLight = true;
    expect(nativeSystemLight()).toBeNull();
    useThemeStore.getState().setMode("auto");
    expect(useThemeStore.getState().shown).toBe("veil");
  });

  it("the browser keeps following the media query live", () => {
    unwatch = watchSystemScheme();
    expect(mediaListeners.size).toBe(1);
    useThemeStore.getState().setMode("auto");
    expect(useThemeStore.getState().shown).toBe("obsidian");
    mediaLight = true;
    for (const fn of mediaListeners) fn();
    expect(useThemeStore.getState().shown).toBe("veil");
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
