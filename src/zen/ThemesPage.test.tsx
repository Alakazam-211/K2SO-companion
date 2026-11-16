// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemesPage, themeSummary } from "./ThemesPage";
import { useThemeStore } from "../theme/themeStore";

const html = () => document.documentElement;
let systemLight = false;

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute("style");
  systemLight = false;
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("light") ? systemLight : !systemLight,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useThemeStore.setState({
    mode: "dark",
    dark: "obsidian",
    light: "veil",
    shown: "obsidian",
    accents: { obsidian: null, veil: null, yellow: null },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Themes", () => {
  it("Light, Dark or Auto, then each side's palettes, then the accent", () => {
    render(<ThemesPage onBack={() => {}} />);
    expect(screen.getAllByRole("radio", { name: /^(Light|Dark|Auto)$/ }).map((b) => b.textContent)).toEqual([
      "Light",
      "Dark",
      "Auto",
    ]);
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("theme-side-light").textContent).toBe("Veil");
    expect(screen.getByTestId("theme-side-dark").textContent).toBe("ObsidianDusk");
    expect(screen.getByTestId("theme-palette-obsidian").getAttribute("aria-checked")).toBe("true");
  });

  it("Light shows the light palette at once and keeps the mode", () => {
    render(<ThemesPage onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("theme-mode-light"));
    expect(html().getAttribute("data-palette")).toBe("veil");
    expect(html().getAttribute("data-scheme")).toBe("light");
    expect(localStorage.getItem("k2.scheme")).toBe("light");
  });

  it("a dark palette card picks it, and moves a Light phone to Dark", () => {
    useThemeStore.setState({ mode: "light", shown: "veil" });
    render(<ThemesPage onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("theme-palette-yellow"));
    expect(html().getAttribute("data-palette")).toBe("yellow");
    expect(localStorage.getItem("k2.scheme")).toBe("dark");
    expect(localStorage.getItem("k2.palette.dark")).toBe("yellow");
  });

  it("Auto follows the system with each side's pick", () => {
    render(<ThemesPage onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("theme-palette-yellow"));
    systemLight = true;
    fireEvent.click(screen.getByTestId("theme-mode-auto"));
    expect(html().getAttribute("data-palette")).toBe("veil");
    expect(screen.getByTestId("themes-appearance").textContent).toContain("Auto follows your iPhone");
    systemLight = false;
    useThemeStore.getState().refresh();
    expect(html().getAttribute("data-palette")).toBe("yellow");
    // Under Auto a card doesn't change the mode.
    fireEvent.click(screen.getByTestId("theme-palette-obsidian"));
    expect(localStorage.getItem("k2.scheme")).toBe("auto");
    expect(html().getAttribute("data-palette")).toBe("obsidian");
  });

  it("an accent for each of the three palettes, starting on the one on screen", () => {
    render(<ThemesPage onBack={() => {}} />);
    expect(screen.getByTestId("accent-palette-obsidian").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("accent-pink"));
    expect(html().style.getPropertyValue("--color-accent")).toBe("#ff375f");
    // Dusk's accent, edited from Obsidian: saved, the screen keeps Obsidian's.
    fireEvent.click(screen.getByTestId("accent-palette-yellow"));
    expect(screen.getByTestId("accent-value").textContent).toBe("Default");
    fireEvent.change(screen.getByTestId("accent-custom"), { target: { value: "#40c8e0" } });
    expect(localStorage.getItem("k2.accent.glass.yellow")).toBe("#40c8e0");
    expect(html().style.getPropertyValue("--color-accent")).toBe("#ff375f");
    // Its own again.
    fireEvent.click(screen.getByTestId("accent-own"));
    expect(localStorage.getItem("k2.accent.glass.yellow")).toBeNull();
    // Switching to Dusk brings Dusk's (its own gold).
    fireEvent.click(screen.getByTestId("theme-palette-yellow"));
    expect(html().style.getPropertyValue("--color-accent")).toBe("#ffc700");
  });

  it("the palette's own is the Default swatch; a preset of the same colour isn't offered twice", () => {
    render(<ThemesPage onBack={() => {}} />);
    expect(screen.getByTestId("accent-own").getAttribute("aria-label")).toBe("Default (Obsidian's own)");
    expect(screen.getByTestId("accent-value").textContent).toBe("Default");
    // Obsidian's own is Glass's blue: no separate Blue swatch.
    expect(screen.queryByTestId("accent-blue")).toBeNull();
    // Dusk's own is its gold: no Yellow, but Blue is back.
    fireEvent.click(screen.getByTestId("accent-palette-yellow"));
    expect(screen.queryByTestId("accent-yellow")).toBeNull();
    expect(screen.getByTestId("accent-blue")).not.toBeNull();
  });

  it("the Settings row says the palette on screen, and Auto", () => {
    expect(themeSummary("yellow", "dark")).toBe("Dusk");
    expect(themeSummary("veil", "auto")).toBe("Auto · Veil");
  });
});
