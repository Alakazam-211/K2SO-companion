import { create } from "zustand";
import { applyTheme, readAccent, readPalette, writeAccent, writePalette, type PaletteId } from "./palettes";
import type { AccentChoice } from "./styleAccent";

/** Settings → Appearance → Palette and Accent (palettes.ts). Each palette
 *  keeps its own accent, so switching palette brings back that palette's. */
type ThemeState = {
  palette: PaletteId;
  /** The current palette's accent; null is the palette's own. */
  accent: AccentChoice | null;
  setPalette: (id: PaletteId) => void;
  setAccent: (choice: AccentChoice | null) => void;
};

export const useThemeStore = create<ThemeState>((set, get) => ({
  palette: readPalette(),
  accent: readAccent(readPalette()),
  setPalette: (id) => {
    writePalette(id);
    const accent = readAccent(id);
    applyTheme(id, accent);
    set({ palette: id, accent });
  },
  setAccent: (choice) => {
    const { palette } = get();
    writeAccent(palette, choice);
    const accent = readAccent(palette);
    applyTheme(palette, accent);
    set({ accent });
  },
}));
