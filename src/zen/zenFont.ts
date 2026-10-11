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

/** Zen content text size (Settings → Appearance → Text Size): a 3-stop
 *  slider. Applied as `--zen-text-scale` on <html>; content text (thread
 *  bubbles, composers, ticket comments/summary, file viewer markdown and
 *  code) sizes as `calc(<px> * var(--zen-text-scale, 1))`. Chrome
 *  (headers, pills, buttons, tab labels, this sheet) and the terminal
 *  (Kessel, own sizing) do not scale. */
export type ZenTextSize = "small" | "default" | "large";

export const ZEN_TEXT_SIZES: { value: ZenTextSize; label: string; scale: number }[] = [
  { value: "small", label: "Small", scale: 0.9 },
  { value: "default", label: "Default", scale: 1 },
  { value: "large", label: "Large", scale: 1.15 },
];

export const ZEN_TEXT_SIZE_STORAGE_KEY = "k2-zen-text-size";
export const ZEN_TEXT_SCALE_VAR = "--zen-text-scale";

function isZenTextSize(v: unknown): v is ZenTextSize {
  return v === "small" || v === "default" || v === "large";
}

export function zenTextScale(size: ZenTextSize): number {
  return ZEN_TEXT_SIZES.find((s) => s.value === size)?.scale ?? 1;
}

/** Inline font size for content text that follows the Text Size pref. */
export function zenTextPx(px: number): string {
  return `calc(${px}px * var(${ZEN_TEXT_SCALE_VAR}, 1))`;
}

export function readZenTextSize(): ZenTextSize {
  try {
    const raw = localStorage.getItem(ZEN_TEXT_SIZE_STORAGE_KEY);
    return isZenTextSize(raw) ? raw : "default";
  } catch {
    return "default";
  }
}

export function writeZenTextSize(size: ZenTextSize): void {
  try {
    localStorage.setItem(ZEN_TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    /* quota / private mode — the choice lasts this session only */
  }
}

/** Set `--zen-text-scale` on <html> (0.9 / 1 / 1.15). */
export function applyZenTextSize(size: ZenTextSize, root?: HTMLElement): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  el.style.setProperty(ZEN_TEXT_SCALE_VAR, String(zenTextScale(size)));
}

interface ZenFontState {
  font: ZenFont;
  setFont: (font: ZenFont) => void;
  textSize: ZenTextSize;
  setTextSize: (size: ZenTextSize) => void;
}

export const useZenFontStore = create<ZenFontState>((set) => ({
  font: readZenFont(),
  setFont: (font) => {
    writeZenFont(font);
    applyZenFont(font);
    set({ font });
  },
  textSize: readZenTextSize(),
  setTextSize: (textSize) => {
    writeZenTextSize(textSize);
    applyZenTextSize(textSize);
    set({ textSize });
  },
}));

/** Boot: restore the saved font and text size onto <html> (main.tsx). */
export function initZenFont(): ZenFont {
  const font = readZenFont();
  const textSize = readZenTextSize();
  applyZenFont(font);
  applyZenTextSize(textSize);
  useZenFontStore.setState({ font, textSize });
  return font;
}
