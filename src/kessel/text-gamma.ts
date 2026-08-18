// WebGL text-weight (coverage gamma) helpers.
//
// The painter thins/fattens glyph edges with `pow(coverage, gamma)`:
//   - dark terminal bg  → 0.7 (fatten; light-on-dark reads thin)
//   - light terminal bg → 1.05 (thin; dark-on-light reads bold)
//
// Companion has no Styles page — paint bakes TEXT_GAMMA_DARK. The
// storage helpers stay so a future settings surface can reuse them
// and so K2SO_WEBGL_TEXT_GAMMA remains the dev escape hatch.

export type StyleScheme = 'dark' | 'light'

/** Dark-theme preset (fatten). Not the clamp floor (0.5) — 0.7 is the feel default. */
export const TEXT_GAMMA_DARK = 0.7
/** Light-theme preset (thin). */
export const TEXT_GAMMA_LIGHT = 1.05
/** Inclusive clamp for store writes and paint-time resolution. */
export const TEXT_GAMMA_MIN = 0.5
export const TEXT_GAMMA_MAX = 3

export function clampTextGamma(v: number): number {
  if (!Number.isFinite(v)) return TEXT_GAMMA_DARK
  return Math.min(TEXT_GAMMA_MAX, Math.max(TEXT_GAMMA_MIN, v))
}

/** localStorage key for a user override of WebGL text weight. */
export function textGammaStorageKey(styleId: string, scheme: StyleScheme): string {
  return `k2.textGamma.${styleId}.${scheme}`
}

/** Read a stored override; null when absent / unreadable / non-finite. */
export function readStoredTextGamma(styleId: string, scheme: StyleScheme): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(textGammaStorageKey(styleId, scheme))
    if (raw == null || raw.trim() === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    return clampTextGamma(n)
  } catch {
    return null
  }
}

/** Persist a per-style / per-scheme override. */
export function writeStoredTextGamma(
  styleId: string,
  scheme: StyleScheme,
  value: number,
): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(textGammaStorageKey(styleId, scheme), String(clampTextGamma(value)))
  } catch {
    // Privacy-mode / full storage — live value still applies via the caller.
  }
}

/** Drop the override so the next resolve falls back to the preset. */
export function clearStoredTextGamma(styleId: string, scheme: StyleScheme): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(textGammaStorageKey(styleId, scheme))
  } catch {
    // Best-effort.
  }
}

/** Relative luminance of a 0xRRGGBB (or CSS hex) terminal background. */
export function relativeLuminance(bg: string | number): number {
  let r8: number
  let g8: number
  let b8: number
  if (typeof bg === 'number') {
    const n = bg >>> 0
    r8 = (n >> 16) & 0xff
    g8 = (n >> 8) & 0xff
    b8 = n & 0xff
  } else {
    const s = bg.trim()
    const hex = s.startsWith('#') ? s.slice(1) : s
    if (hex.length === 3) {
      r8 = parseInt(hex[0] + hex[0], 16)
      g8 = parseInt(hex[1] + hex[1], 16)
      b8 = parseInt(hex[2] + hex[2], 16)
    } else if (hex.length === 6) {
      r8 = parseInt(hex.slice(0, 2), 16)
      g8 = parseInt(hex.slice(2, 4), 16)
      b8 = parseInt(hex.slice(4, 6), 16)
    } else {
      return 0
    }
    if (![r8, g8, b8].every((c) => Number.isFinite(c))) return 0
  }
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r8) + 0.7152 * lin(g8) + 0.0722 * lin(b8)
}

/** Rosson's calibration: dark bg → 0.7, light bg → 1.05. */
export function defaultTextGammaFor(bg: string | number): number {
  return relativeLuminance(bg) < 0.5 ? TEXT_GAMMA_DARK : TEXT_GAMMA_LIGHT
}
