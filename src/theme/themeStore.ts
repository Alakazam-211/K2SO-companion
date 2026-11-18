import { create } from "zustand";
import {
  applyTheme,
  nativeLook,
  PALETTES,
  readAccent,
  readSelection,
  resolvePalette,
  selectPalette,
  systemPrefersLight,
  writeAccent,
  writeSelection,
  type PaletteId,
  type SchemeMode,
  type StyleScheme,
  type ThemeSelection,
} from "./palettes";
import type { AccentChoice } from "./styleAccent";
import { nativeAppearanceAvailable, onNativeSystemAppearance, syncNativeAppearance } from "./nativeAppearance";

/** Settings → Themes (ThemesPage.tsx; desktop's Settings → Themes): Light,
 *  Dark or Auto; the palette for each side (under Auto, the two picks);
 *  and an accent for each of the three palettes. */
type ThemeState = ThemeSelection & {
  /** The palette on screen (Auto resolved against the system). */
  shown: PaletteId;
  /** Each palette's accent; null is the palette's own. */
  accents: Record<PaletteId, AccentChoice | null>;
  setMode: (mode: SchemeMode) => void;
  /** A palette card: that side's palette, any of the three (outside Auto, the mode follows). */
  pickPalette: (side: StyleScheme, id: PaletteId) => void;
  setAccent: (id: PaletteId, choice: AccentChoice | null) => void;
  /** The system's appearance changed (Auto). */
  refresh: () => void;
};

function readAccents(): Record<PaletteId, AccentChoice | null> {
  return Object.fromEntries(PALETTES.map((p) => [p.id, readAccent(p.id)])) as Record<PaletteId, AccentChoice | null>;
}

/** Persist a selection, stamp what it shows, and return the state to set. */
function commit(sel: ThemeSelection): Pick<ThemeState, "mode" | "dark" | "light" | "shown"> {
  const light = systemPrefersLight();
  writeSelection(sel, light);
  const shown = resolvePalette(sel, light);
  applyTheme(shown, readAccent(shown));
  syncNativeAppearance(nativeLook(sel, light));
  return { mode: sel.mode, dark: sel.dark, light: sel.light, shown };
}

const initial = readSelection();

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...initial,
  shown: resolvePalette(initial),
  accents: readAccents(),
  setMode: (mode) => {
    const { dark, light } = get();
    set(commit({ mode, dark, light }));
  },
  pickPalette: (side, id) => {
    const { mode, dark, light } = get();
    set(commit(selectPalette({ mode, dark, light }, side, id)));
  },
  setAccent: (id, choice) => {
    writeAccent(id, choice);
    const accents = { ...get().accents, [id]: readAccent(id) };
    const { shown } = get();
    if (id === shown) applyTheme(shown, accents[id]);
    set({ accents });
  },
  refresh: () => {
    const { mode, dark, light, shown } = get();
    const systemLight = systemPrefersLight();
    const next = resolvePalette({ mode, dark, light }, systemLight);
    // Native under Auto has already restyled for the iPhone; this moves
    // the colour behind the page with it (deduped: nothing changed,
    // nothing sent).
    syncNativeAppearance(nativeLook({ mode, dark, light }, systemLight));
    if (next === shown) return;
    applyTheme(next, readAccent(next));
    set({ shown: next });
  },
}));

/** Under Auto, follow the system's light/dark as it changes. On the phone
 *  native reports the iPhone's appearance (nativeAppearance.ts): the web
 *  view's media query there is native's override (the palette on screen),
 *  not the iPhone. Elsewhere, the media query. */
export function watchSystemScheme(): () => void {
  const onChange = () => useThemeStore.getState().refresh();
  if (nativeAppearanceAvailable()) return onNativeSystemAppearance(onChange);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}
