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
import { accentStorageKey, accentVarsFor, ACCENT_VARS, parseAccentChoice, type AccentChoice } from "./styleAccent";
import { resolveAllColorMix } from "./colorMix";

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

/** tokens.json groups the phone already defines its own way and doesn't take
 *  yet: `--tile-*` (index.css's Glass tiles, with iOS 15 fallbacks) moves to
 *  the palette's values in the dark conversion (stage 2), on purpose, not
 *  as a side effect of stamping. */
const SHARED_GROUPS_LATER = new Set(["tile"]);

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

export const SCHEME_KEY = "k2.scheme";
export const paletteKey = (scheme: StyleScheme): string => `k2.palette.${scheme}`;

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

/** The chosen palette: the scheme picks which of `k2.palette.<scheme>` to
 *  read; a palette of the wrong scheme (or none) falls back to that
 *  scheme's default (Obsidian for dark, Veil for light). */
export function readPalette(): PaletteId {
  const scheme: StyleScheme = read(SCHEME_KEY) === "light" ? "light" : "dark";
  const stored = paletteById(read(paletteKey(scheme)));
  if (stored && stored.scheme === scheme) return stored.id;
  return scheme === "light" ? "veil" : DEFAULT_PALETTE;
}

export function writePalette(id: PaletteId): void {
  const p = paletteById(id);
  if (!p) return;
  write(SCHEME_KEY, p.scheme);
  write(paletteKey(p.scheme), p.id);
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

/** main.tsx, before the first render: the stored palette and accent. */
export function initTheme(): void {
  const id = readPalette();
  applyTheme(id, readAccent(id));
}
