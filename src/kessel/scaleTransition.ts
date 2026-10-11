// Scale-wrapper transition — desktop Kessel parity.
//
// Desktop's TerminalPane animates its scale wrapper with
// `transform 120ms ease-out` so a claim takeover, a resize
// hold-and-scale or a new grid size reads as a smooth reflow instead
// of a snap. It is armed only once a show has settled (two rAFs), so a
// first paint or a re-show never zooms in from a stale scale.
//
// The phone positions the scaled grid with an explicit clip box
// (left/top/width/height) around the scaled layer, so those animate in
// step with the transform; otherwise the clip box would snap to the new
// size while the content is still easing.

export const SCALE_TRANSITION_MS = 120

const PROPS = ['transform', 'left', 'top', 'width', 'height'] as const

/** CSS `transition` for the scale wrapper; `none` until armed. */
export function scaleTransitionCss(armed: boolean): string {
  if (!armed) return 'none'
  return PROPS.map((p) => `${p} ${SCALE_TRANSITION_MS}ms ease-out`).join(', ')
}
