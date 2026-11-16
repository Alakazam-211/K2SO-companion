// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccentRow, PaletteRow } from "./ThemeRows";
import { useThemeStore } from "../theme/themeStore";

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute("style");
  useThemeStore.setState({ palette: "obsidian", accent: null });
});
afterEach(cleanup);

describe("Settings → Appearance → Palette", () => {
  it("offers Obsidian, Veil and Dusk; Obsidian is picked by default", () => {
    render(<PaletteRow />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Obsidian", "Veil", "Dusk"]);
    expect(screen.getByTestId("palette-obsidian").getAttribute("aria-checked")).toBe("true");
  });

  it("a tap applies the palette at once and keeps it on this phone", () => {
    render(<PaletteRow />);
    fireEvent.click(screen.getByTestId("palette-yellow"));
    expect(html().getAttribute("data-palette")).toBe("yellow");
    expect(html().style.getPropertyValue("--color-bg")).toBe("#100f0e");
    expect(localStorage.getItem("k2.palette.dark")).toBe("yellow");
    expect(screen.getByTestId("palette-yellow").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Settings → Appearance → Accent", () => {
  it("starts on the palette's own; a preset applies its derived colours", () => {
    render(<AccentRow />);
    expect(screen.getByTestId("accent-own").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("accent-value").textContent).toBe("Obsidian's own");
    fireEvent.click(screen.getByTestId("accent-pink"));
    expect(html().style.getPropertyValue("--color-accent")).toBe("#ff375f");
    expect(localStorage.getItem("k2.accent.glass.obsidian")).toBe("#ff375f");
    expect(screen.getByTestId("accent-value").textContent).toBe("Pink");
    fireEvent.click(screen.getByTestId("accent-own"));
    expect(localStorage.getItem("k2.accent.glass.obsidian")).toBeNull();
  });

  it("any colour from the picker", () => {
    render(<AccentRow />);
    fireEvent.change(screen.getByTestId("accent-custom"), { target: { value: "#123456" } });
    expect(html().style.getPropertyValue("--color-accent")).toBe("#123456");
    expect(screen.getByTestId("accent-value").textContent).toBe("#123456".toUpperCase());
  });

  it("each palette keeps its own accent", () => {
    render(
      <>
        <PaletteRow />
        <AccentRow />
      </>
    );
    fireEvent.click(screen.getByTestId("accent-green"));
    fireEvent.click(screen.getByTestId("palette-yellow"));
    // Dusk has no choice yet: its own gold.
    expect(screen.getByTestId("accent-value").textContent).toBe("Dusk's own");
    expect(html().style.getPropertyValue("--color-accent")).toBe("#ffc700");
    fireEvent.click(screen.getByTestId("palette-obsidian"));
    expect(screen.getByTestId("accent-value").textContent).toBe("Green");
    expect(html().style.getPropertyValue("--color-accent")).toBe("#30d158");
  });
});
