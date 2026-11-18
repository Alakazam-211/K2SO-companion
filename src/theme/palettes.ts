// K2 desktop Glass's three palettes on the phone (Riley via K2 Design,
// 2026-11-16; wiki "Plan - Glass Palettes"). The token files in ./glass are
// desktop's styles/glass/palettes/*.json, tokens.json and style.json as they
// are (W3C design-token JSON); this module turns them into CSS custom
// properties under desktop's names (`--color-bg`, `--color-accent-text`, …)
// and stamps the chosen palette, plus its accent (styleAccent.ts), on <html>.
//
// The choice is per device, as on the desktop (not daemon state): the same
// localStorage keys, `k2.scheme`, `k2.palette.<scheme>` and
// `k2.accent.glass.<palette>`. Read synchronously so main.tsx can stamp it
// before the first paint.

import obsidian from "./glass/obsidian.json";
import veil from "./glass/veil.json";
import dusk from "./glass/yellow.json";
import tokens from "./glass/tokens.json";
import {
  accentStorageKey,
  accentTextFor,
  accentVarsFor,
  ACCENT_VARS,
  defaultAccentHex,
  parseAccentChoice,
  type AccentChoice,
} from "./styleAccent";
import { resolveAllColorMix } from "./colorMix";
import { nativeSystemLight, syncNativeAppearance, type NativeAppearance } from "./nativeAppearance";

export type StyleScheme = "dark" | "light";
export type PaletteId = "obsidian" | "veil" | "yellow";

/** What styleAccent.ts reads of a palette: its grounds and its own accent. */
export type StylePaletteMeta = {
  id: string;
  swatch: { bg: string; surface: string; elevated: string; accent: string };
};

type TokenTree = { [key: string]: unknown };

export type Palette = StylePaletteMeta & {
  id: PaletteId;
  /** The name the picker shows (desktop's: `yellow` is Dusk). */
  name: string;
  scheme: StyleScheme;
  /** Every CSS property the palette sets: `--color-*` and `--terminal-*`. */
  vars: Readonly<Record<string, string>>;
};

export const STYLE_ID = "glass";
/** Glass's one blue, which `var(--glass-accent)` in Obsidian and Veil names. */
export const GLASS_BLUE = "#0a84ff";

/** Flatten a token group into CSS properties: `{bg: {$value}}` under prefix
 *  `--color` → `--color-bg`. Nested groups join with `-`. */
export function tokenVars(group: TokenTree, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, node] of Object.entries(group)) {
    if (key.startsWith("$") || !node || typeof node !== "object") continue;
    const n = node as TokenTree;
    if ("$value" in n) out[`${prefix}-${key}`] = String(n.$value);
    else Object.assign(out, tokenVars(n, `${prefix}-${key}`));
  }
  return out;
}

function palette(json: TokenTree, name: string): Palette {
  const id = String(json.id) as PaletteId;
  const scheme = ((json.schemes as string[] | undefined)?.[0] === "light" ? "light" : "dark") as StyleScheme;
  const vars = {
    ...tokenVars(json.color as TokenTree, "--color"),
    ...tokenVars((json.terminal as TokenTree) ?? {}, "--terminal"),
  };
  return {
    id,
    name,
    scheme,
    vars,
    swatch: {
      bg: vars["--color-bg"],
      surface: vars["--color-bg-surface"],
      elevated: vars["--color-bg-elevated"],
      accent: vars["--color-accent"],
    },
  };
}

/** In the picker's order. */
export const PALETTES: readonly Palette[] = [
  palette(obsidian as TokenTree, "Obsidian"),
  palette(veil as TokenTree, "Veil"),
  palette(dusk as TokenTree, "Dusk"),
];

export const DEFAULT_PALETTE: PaletteId = "obsidian";

export function paletteById(id: string | null | undefined): Palette | null {
  return PALETTES.find((p) => p.id === id) ?? null;
}

/** tokens.json groups the phone defines its own way and doesn't take.
 *  `--radius-*`: the phone's own `--radius-pill` is 4px (the terminal grid's
 *  pills, TerminalGridParts.tsx); desktop's 999px would round them. `--tile-*`
 *  does come from here (index.css's Glass tiles), color-mix() resolved. */
const SHARED_GROUPS_LATER = new Set<string>(["radius"]);

/** The shared Glass values every palette uses (radius, material, motion…),
 *  under desktop's names: `--radius-box`, `--material-blur`, … */
export const SHARED_VARS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(tokens as TokenTree).flatMap(([group, node]) =>
    group.startsWith("$") || SHARED_GROUPS_LATER.has(group) || !node || typeof node !== "object"
      ? []
      : Object.entries(tokenVars(node as TokenTree, `--${group}`))
  )
);

// ─── Storage (desktop's keys; per device) ────────────────────────────────
//
// As desktop's stores/style.ts: `k2.scheme` is the MODE (`light`, `dark` or
// `auto`); `k2.palette.dark` / `k2.palette.light` are each side's palette
// (under Auto, the two picks); `k2.palette` mirrors the palette on screen;
// `k2.style` is `glass` (the phone has only Glass).

export type SchemeMode = StyleScheme | "auto";

/** The look as chosen: the mode, and the palette for each side. */
export type ThemeSelection = { mode: SchemeMode; dark: PaletteId; light: PaletteId };

export const STYLE_KEY = "k2.style";
export const SCHEME_KEY = "k2.scheme";
export const PALETTE_KEY = "k2.palette";
export const paletteKey = (scheme: StyleScheme): string => `${PALETTE_KEY}.${scheme}`;

/** The phone's look before anyone picks (Riley 2026-11-16): Auto, with
 *  Obsidian by day (the iPhone in Light) and Dusk at night (Dark). Both
 *  dark, so the black launch screen fits either. A stored choice wins. */
export const DEFAULT_SELECTION: Readonly<ThemeSelection> = { mode: "auto", dark: "yellow", light: "obsidian" };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: the choice lasts this session only */
  }
}

export function parseSchemeMode(raw: string | null): SchemeMode {
  return raw === "light" || raw === "dark" || raw === "auto" ? raw : DEFAULT_SELECTION.mode;
}

/** A side's palette: the stored one if it is for that side, else the
 *  side's default (Obsidian for dark, Veil for light). */
function sidePalette(scheme: StyleScheme): PaletteId {
  // Any of the three on either side (Riley 2026-11-16: "for the light
  // palette you should be able to choose any of the three"); junk falls
  // back to the side's default.
  return paletteById(read(paletteKey(scheme)))?.id ?? DEFAULT_SELECTION[scheme];
}

export function readSelection(): ThemeSelection {
  return { mode: parseSchemeMode(read(SCHEME_KEY)), dark: sidePalette("dark"), light: sidePalette("light") };
}

/** True when iOS (or the browser) shows light; only Auto reads it
 *  (resolveScheme). On the phone the web view's `prefers-color-scheme` is
 *  native's override (the palette on screen, src-tauri/src/appearance.rs),
 *  so the iPhone's own appearance comes from native (nativeSystemLight:
 *  what it last reported, kept from the last launch). Only before native
 *  has ever answered on this device does the phone fall back to the media
 *  query. The browser and tests read the media query. */
export function systemPrefersLight(): boolean {
  const native = nativeSystemLight();
  if (native !== null) return native;
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
      : false;
  } catch {
    return false;
  }
}

/** The side a mode shows: Auto follows the system. */
export function resolveScheme(mode: SchemeMode, systemLight = systemPrefersLight()): StyleScheme {
  return mode === "auto" ? (systemLight ? "light" : "dark") : mode;
}

/** The palette on screen for a selection. */
export function resolvePalette(sel: ThemeSelection, systemLight = systemPrefersLight()): PaletteId {
  return sel[resolveScheme(sel.mode, systemLight)];
}

export function writeSelection(sel: ThemeSelection, systemLight = systemPrefersLight()): void {
  write(STYLE_KEY, STYLE_ID);
  write(SCHEME_KEY, sel.mode);
  write(paletteKey("dark"), sel.dark);
  write(paletteKey("light"), sel.light);
  write(PALETTE_KEY, resolvePalette(sel, systemLight));
}

/** Pick a palette card under Light or Dark: any palette can be either
 *  side's. Outside Auto the mode moves to the side picked for, so the pick
 *  shows at once; under Auto it waits for the system to show that side. */
export function selectPalette(sel: ThemeSelection, side: StyleScheme, id: PaletteId): ThemeSelection {
  const p = paletteById(id);
  if (!p) return sel;
  return { ...sel, [side]: p.id, mode: sel.mode === "auto" ? "auto" : side };
}

export function readAccent(id: PaletteId): AccentChoice | null {
  return parseAccentChoice(read(accentStorageKey(STYLE_ID, id)));
}

/** `null`: back to the palette's own accent. */
export function writeAccent(id: PaletteId, choice: AccentChoice | null): void {
  write(accentStorageKey(STYLE_ID, id), choice === null ? null : parseAccentChoice(choice));
}

// ─── Applying ────────────────────────────────────────────────────────────

export const PALETTE_ATTR = "data-palette";
export const SCHEME_ATTR = "data-scheme";

/** Every property a palette and its accent write, for one palette. Shared
 *  values first, then the palette, then the accent's overrides; every
 *  color-mix() resolved to a plain colour (iOS 15–16.1 have none). */
export function themeVars(id: PaletteId, accent: AccentChoice | null): Record<string, string> {
  const p = paletteById(id) ?? PALETTES[0];
  return resolveAllColorMix({
    ...SHARED_VARS,
    "--glass-accent": GLASS_BLUE,
    // The accent as words: the palettes reference it (status-working) but
    // don't define it; desktop's base stylesheet does. Worked out the same
    // way here for the palette's own accent (a custom one overrides it).
    "--color-accent-text": accentTextFor(defaultAccentHex(p), p, p.scheme),
    // Dusk names no accent fill (its gold already carries its ink): desktop
    // reads `var(--color-accent-fill, var(--color-accent))`, so the fill is
    // the accent itself there. The same here, so every palette has one.
    "--color-accent-fill": "var(--color-accent)",
    "--color-accent-fill-hover": "var(--color-accent-hover)",
    ...p.vars,
    ...accentVarsFor(accent, p, p.scheme),
  });
}

/** Every property any palette may have written: cleared before a new stamp
 *  so nothing from the last palette lingers (a key only one file has). */
const ALL_VARS: readonly string[] = Array.from(
  new Set([
    ...Object.keys(SHARED_VARS),
    "--glass-accent",
    ...PALETTES.flatMap((p) => Object.keys(p.vars)),
    ...ACCENT_VARS,
  ])
);

/** Stamp a palette and its accent on <html> (or `root`): the properties,
 *  `data-palette`, `data-scheme` and `color-scheme`. */
export function applyTheme(id: PaletteId, accent: AccentChoice | null, root?: HTMLElement): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  const p = paletteById(id) ?? PALETTES[0];
  for (const name of ALL_VARS) el.style.removeProperty(name);
  for (const [name, value] of Object.entries(themeVars(p.id, accent))) el.style.setProperty(name, value);
  el.setAttribute(PALETTE_ATTR, p.id);
  el.setAttribute(SCHEME_ATTR, p.scheme);
  el.style.colorScheme = p.scheme;
}

/** A palette's page colour (`--color-bg`), for the native side. */
export function paletteBg(id: PaletteId): string {
  const p = paletteById(id) ?? PALETTES[0];
  return p.vars["--color-bg"] ?? (p.scheme === "light" ? "#ffffff" : "#000000");
}

/** A palette's scheme (Obsidian and Dusk dark, Veil light). */
export function paletteScheme(id: PaletteId): StyleScheme {
  return (paletteById(id) ?? PALETTES[0]).scheme;
}

/** What the native side is told for a selection: the mode, the page colour
 *  on screen, and each side's page colour and palette scheme. Native gives
 *  the keyboard, status bar and sheets the scheme of the palette on screen
 *  (Auto: the side the iPhone is in), so a dark palette picked for the day
 *  side keeps them dark, under Light and under Auto alike. */
export function nativeLook(sel: ThemeSelection, systemLight = systemPrefersLight()): NativeAppearance {
  return {
    mode: sel.mode,
    bg: paletteBg(resolvePalette(sel, systemLight)),
    darkBg: paletteBg(sel.dark),
    lightBg: paletteBg(sel.light),
    darkScheme: paletteScheme(sel.dark),
    lightScheme: paletteScheme(sel.light),
  };
}

/** main.tsx, before the first render: the stored palette and accent, and
 *  the look to the native side (keyboard, status bar, next launch). */
export function initTheme(): void {
  const sel = readSelection();
  const light = systemPrefersLight();
  const id = resolvePalette(sel, light);
  applyTheme(id, readAccent(id));
  syncNativeAppearance(nativeLook(sel, light));
}
