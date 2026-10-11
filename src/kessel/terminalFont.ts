// Terminal font — desktop Kessel parity.
//
// Desktop's `defaultKesselConfig.font.family` leads with MesloLGM Nerd
// Font. The phone bundles the same TTFs (Regular + Bold, styles/index.css
// `@font-face "MesloLGM Nerd Font Mono"`), so the terminal uses them too:
// same advance and ascent as desktop, and Nerd/powerline private-use
// glyphs (prompt arrows, file icons) render instead of tofu — SF Mono
// has none of them.
//
// The @font-face is `font-display: swap` and lazily loaded, so a cell
// probe or atlas raster that runs before the face is ready measures and
// caches the fallback font. `loadTerminalFont` asks the FontFaceSet for
// both weights up front; the view re-probes and rebuilds the atlas when
// it resolves (see `fontEpoch` in TerminalView).

/** Same order desktop uses, with the phone's @font-face name first. */
export const TERMINAL_FONT_FAMILY =
  "'MesloLGM Nerd Font Mono', 'MesloLGM Nerd Font', 'SF Mono', Menlo, ui-monospace, monospace"

/** The @font-face family the phone bundles (styles/index.css). */
export const TERMINAL_FONT_FACE = 'MesloLGM Nerd Font Mono'

interface FontFaceSetLike {
  load(font: string, text?: string): Promise<unknown[]>
}

/** Resolve once both bundled weights are usable. `true` when the face
 *  loaded, `false` when there is no FontFaceSet (old WebKit, tests) or
 *  the load failed — callers keep the fallback metrics either way.
 *  Never rejects. */
export async function loadTerminalFont(
  fontSizePx: number,
  fonts: FontFaceSetLike | null | undefined = typeof document !== 'undefined'
    ? (document as Document & { fonts?: FontFaceSetLike }).fonts
    : undefined,
): Promise<boolean> {
  if (!fonts || typeof fonts.load !== 'function') return false
  const face = `"${TERMINAL_FONT_FACE}"`
  try {
    const [regular, bold] = await Promise.all([
      fonts.load(`${fontSizePx}px ${face}`),
      fonts.load(`bold ${fontSizePx}px ${face}`),
    ])
    return regular.length > 0 && bold.length > 0
  } catch {
    return false
  }
}
