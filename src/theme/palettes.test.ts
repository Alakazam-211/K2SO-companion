// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  initTheme,
  PALETTES,
  paletteById,
  readAccent,
  readSelection,
  resolvePalette,
  resolveScheme,
  SCHEME_KEY,
  selectPalette,
  themeVars,
  tokenVars,
  writeAccent,
  writeSelection,
} from "./palettes";

beforeEach(() => {
  localStorage.clear();
  const el = document.documentElement;
  el.removeAttribute("style");
  el.removeAttribute("data-palette");
  el.removeAttribute("data-scheme");
});

describe("the three Glass palettes", () => {
  it("are Obsidian, Veil and Dusk (desktop's ids), with their schemes and grounds", () => {
    expect(PALETTES.map((p) => [p.id, p.name, p.scheme])).toEqual([
      ["obsidian", "Obsidian", "dark"],
      ["veil", "Veil", "light"],
      ["yellow", "Dusk", "dark"],
    ]);
    expect(paletteById("obsidian")?.swatch).toMatchObject({ bg: "#0a0a0a", surface: "#1c1c1e" });
    expect(paletteById("veil")?.swatch).toMatchObject({ bg: "#fafafa", surface: "#ffffff" });
    expect(paletteById("yellow")?.swatch).toMatchObject({ bg: "#100f0e", accent: "#ffc700" });
  });

  it("flatten tokens to desktop's names", () => {
    expect(tokenVars({ bg: { $value: "#000" }, ring: { edge: { $value: "x" } }, $type: "color" }, "--color")).toEqual({
      "--color-bg": "#000",
      "--color-ring-edge": "x",
    });
    expect(paletteById("yellow")?.vars["--color-on-accent"]).toBe("#1a1400");
    expect(paletteById("obsidian")?.vars["--terminal-bg"]).toBe("#0a0a0a");
  });

  it("stamp no color-mix() anywhere (iOS 15–16.1), for every palette, with and without a custom accent", () => {
    for (const p of PALETTES) {
      for (const accent of [null, "#ff375f", "yellow"]) {
        const vars = themeVars(p.id, accent);
        const mixes = Object.entries(vars).filter(([, v]) => /color-mix\(/.test(v));
        expect(mixes, `${p.id} ${accent}`).toEqual([]);
      }
    }
    // Obsidian's own accent is Glass's blue; its fill is the blue deepened.
    expect(themeVars("obsidian", null)["--color-accent-fill"]).toBe("#086cd1");
  });

  it("Veil has its own frost: a 72% white fill", () => {
    expect(themeVars("veil", null)["--color-frost-fill"]).toBe("rgba(255, 255, 255, 0.72)");
    expect(themeVars("obsidian", null)["--color-frost-fill"]).toBe("rgba(255, 255, 255, 0.10)");
  });
});

describe("the choice is per device, under desktop's keys", () => {
  it("defaults to Dark with Obsidian, Veil for light", () => {
    expect(readSelection()).toEqual({ mode: "dark", dark: "obsidian", light: "veil" });
    expect(resolvePalette(readSelection(), true)).toBe("obsidian");
  });

  it("stores the mode and each side's palette, and mirrors the palette on screen", () => {
    writeSelection({ mode: "auto", dark: "yellow", light: "veil" }, true);
    expect(localStorage.getItem(SCHEME_KEY)).toBe("auto");
    expect(localStorage.getItem("k2.palette.dark")).toBe("yellow");
    expect(localStorage.getItem("k2.palette.light")).toBe("veil");
    expect(localStorage.getItem("k2.palette")).toBe("veil");
    expect(localStorage.getItem("k2.style")).toBe("glass");
    expect(readSelection()).toEqual({ mode: "auto", dark: "yellow", light: "veil" });
  });

  it("Auto follows the system; Light and Dark don't", () => {
    const sel = { mode: "auto" as const, dark: "yellow" as const, light: "veil" as const };
    expect(resolveScheme("auto", true)).toBe("light");
    expect(resolvePalette(sel, true)).toBe("veil");
    expect(resolvePalette(sel, false)).toBe("yellow");
    expect(resolvePalette({ ...sel, mode: "dark" }, true)).toBe("yellow");
    expect(resolvePalette({ ...sel, mode: "light" }, false)).toBe("veil");
  });

  it("a palette card sets its side; outside Auto the mode follows it (desktop's rule)", () => {
    const sel = { mode: "light" as const, dark: "obsidian" as const, light: "veil" as const };
    expect(selectPalette(sel, "yellow")).toEqual({ mode: "dark", dark: "yellow", light: "veil" });
    expect(selectPalette({ ...sel, mode: "auto" }, "yellow")).toEqual({ mode: "auto", dark: "yellow", light: "veil" });
  });

  it("a palette stored for the wrong side, or junk, falls back to the side's default", () => {
    localStorage.setItem("k2.palette.light", "obsidian");
    localStorage.setItem("k2.palette.dark", "<script>");
    localStorage.setItem(SCHEME_KEY, "sepia");
    expect(readSelection()).toEqual({ mode: "dark", dark: "obsidian", light: "veil" });
  });

  it("each palette keeps its own accent (k2.accent.glass.<palette>); junk is the default", () => {
    writeAccent("obsidian", "#FF375F");
    writeAccent("yellow", "#30d158");
    expect(localStorage.getItem("k2.accent.glass.obsidian")).toBe("#ff375f");
    expect(readAccent("obsidian")).toBe("#ff375f");
    expect(readAccent("yellow")).toBe("#30d158");
    expect(readAccent("veil")).toBeNull();
    writeAccent("obsidian", null);
    expect(readAccent("obsidian")).toBeNull();
    localStorage.setItem("k2.accent.glass.veil", "red; background: url(x)");
    expect(readAccent("veil")).toBeNull();
  });
});

describe("applyTheme", () => {
  it("stamps the palette, its scheme and its vars on <html>", () => {
    applyTheme("veil", null);
    const el = document.documentElement;
    expect(el.getAttribute("data-palette")).toBe("veil");
    expect(el.getAttribute("data-scheme")).toBe("light");
    expect(el.style.getPropertyValue("--color-bg")).toBe("#fafafa");
    expect(el.style.getPropertyValue("--glass-accent")).toBe("#0a84ff");
  });

  it("a custom accent writes the derived slots; switching back clears them", () => {
    applyTheme("obsidian", "#ffffff");
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--color-accent")).toBe("#ffffff");
    // White can't carry white text: the label turns to ink.
    expect(el.style.getPropertyValue("--color-on-accent")).toBe("#141414");
    applyTheme("obsidian", null);
    // The palette's own: desktop's reference to Glass's one blue.
    expect(el.style.getPropertyValue("--color-accent")).toBe("var(--glass-accent)");
    expect(el.style.getPropertyValue("--glass-accent")).toBe("#0a84ff");
    expect(el.style.getPropertyValue("--color-on-accent")).toBe("#ffffff");
    expect(el.style.getPropertyValue("--color-accent-edge")).toBe("");
  });

  it("Dusk carries ink on its gold", () => {
    applyTheme("yellow", null);
    expect(document.documentElement.style.getPropertyValue("--color-on-accent")).toBe("#1a1400");
  });

  it("initTheme applies what was stored", () => {
    writeSelection({ mode: "dark", dark: "yellow", light: "veil" }, false);
    writeAccent("yellow", "#40c8e0");
    initTheme();
    expect(document.documentElement.getAttribute("data-palette")).toBe("yellow");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#40c8e0");
  });
});
