import { create } from "zustand";

/** Zen UI font choice (Settings → Appearance → Font). The CSS lives in
 *  styles/index.css: `--zen-font` is the system stack by default and
 *  switches to Meslo under `:root[data-zen-font="meslo"]`. Code blocks and
 *  the terminal keep their own monospace. */
export type ZenFont = "system" | "meslo";

export const ZEN_FONTS: { value: ZenFont; label: string }[] = [
  { value: "system", label: "System" },
  { value: "meslo", label: "Meslo Nerd Font" },
];

/** Same per-device localStorage idiom as the other Zen UI prefs
 *  (`k2-zen-pinned-ids`). Synchronous, so the font is set before the
 *  first paint. */
export const ZEN_FONT_STORAGE_KEY = "k2-zen-font";
export const ZEN_FONT_ATTR = "data-zen-font";

function isZenFont(v: unknown): v is ZenFont {
  return v === "system" || v === "meslo";
}

export function readZenFont(): ZenFont {
  try {
    const raw = localStorage.getItem(ZEN_FONT_STORAGE_KEY);
    return isZenFont(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function writeZenFont(font: ZenFont): void {
  try {
    localStorage.setItem(ZEN_FONT_STORAGE_KEY, font);
  } catch {
    /* quota / private mode — the choice lasts this session only */
  }
}

/** Stamp the choice on <html>. "system" removes the attribute. */
export function applyZenFont(font: ZenFont, root?: HTMLElement): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  if (font === "system") el.removeAttribute(ZEN_FONT_ATTR);
  else el.setAttribute(ZEN_FONT_ATTR, font);
}

interface ZenFontState {
  font: ZenFont;
  setFont: (font: ZenFont) => void;
}

export const useZenFontStore = create<ZenFontState>((set) => ({
  font: readZenFont(),
  setFont: (font) => {
    writeZenFont(font);
    applyZenFont(font);
    set({ font });
  },
}));

/** Boot: restore the saved choice onto <html> (main.tsx). */
export function initZenFont(): ZenFont {
  const font = readZenFont();
  applyZenFont(font);
  useZenFontStore.setState({ font });
  return font;
}
