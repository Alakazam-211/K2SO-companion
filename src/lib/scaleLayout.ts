// ── Passive scale-to-fit + pin-to-size layout (Kessel port) ────────
//
// Ported from the desktop's `kessel-term/scaleLayout.ts` (T2). Pure:
// geometry in, transform out — unit-tested in
// scripts/test-scale-claim.mjs.
//
// When ANOTHER client owns the PTY size (a desktop drove the dims, or
// the session is pinned by someone else), the grid can be bigger than
// the phone's terminal box. The only lossless treatments of a
// width-committed grid are scale, letterbox or clip — NEVER re-wrap
// (1:1 grid row → display row is preserved: the whole strip scales
// uniformly). Scale factor is min(fitW, fitH, 1), centered/
// letterboxed, floored (see below) after which we clip instead
// (unreadably small is worse than clipped). An active client renders
// 1:1 — its resizes drive the PTY, so any mismatch is transient (the
// hold-and-scale path covers it).
//
// Pin-to-size: while the session is PINNED the daemon clamps every
// resize, so the incoming grid dims converge on the pinned grid for
// EVERY viewer — including the active one. The active viewer
// therefore loses its centered-1:1 privilege when the pinned grid
// overflows its box: it letterboxes like a passive viewer (else it
// would clip a size it cannot change). A pinned grid that FITS still
// renders centered 1:1. The scale floor also drops from 0.4 to 0.25 —
// a deliberate pin means the user prefers shrink-to-fit over
// clipping; the un-pinned passive path keeps 0.4.
//
// Companion deviation from the desktop source: the input takes the
// AVAILABLE content box (`availWidth`/`availHeight` — the caller
// subtracts its own padding) instead of baking the desktop pane's
// 4px padding formula in; the companion strip pads 8px L/R + 4px T/B.

/** Floor for the un-pinned passive scale-to-fit path. */
export const PASSIVE_SCALE_FLOOR = 0.4;
/** Lower floor while pinned — shrink-to-fit was asked for. */
export const PINNED_SCALE_FLOOR = 0.25;

export interface ScaleLayoutResult {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Drives the "viewing at C×R" pill. Never true while pinned —
   *  the pin badge is the pinned-state affordance. */
  passive: boolean;
}

export interface ScaleLayoutInput {
  /** Grid dims of the current frame (0 while none). */
  snapCols: number;
  snapRows: number;
  /** Measured cell metrics (0 until the probe ran). */
  cellWidth: number;
  cellHeight: number;
  /** Available CONTENT box (container minus the strip's padding). */
  availWidth: number;
  availHeight: number;
  /** This client is the resize authority right now (claimer mode,
   *  unpinned-by-others, and the frames track OUR dims — or a resize
   *  we sent is in flight). */
  isActiveViewer: boolean;
  /** Session is pinned to a fixed size. The daemon clamps all
   *  resizes while pinned, so snapCols/snapRows equal the pinned
   *  grid once the frames converge. */
  pinned: boolean;
  /** Resize hold-and-scale: an emitted resize/claim whose frames
   *  haven't landed yet (active path only). */
  pendingResize: { cols: number; rows: number } | null;
}

const IDENTITY: ScaleLayoutResult = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  passive: false,
};

export function computeScaleLayout(input: ScaleLayoutInput): ScaleLayoutResult {
  const {
    snapCols,
    snapRows,
    cellWidth: cw,
    cellHeight: ch,
    availWidth,
    availHeight,
    isActiveViewer,
    pinned,
    pendingResize,
  } = input;
  if (!snapCols || !snapRows || !cw || !ch) return IDENTITY;
  const availW = Math.max(0, availWidth);
  const availH = Math.max(0, availHeight);
  if (!availW || !availH) return IDENTITY;
  const gridW = snapCols * cw;
  const gridH = snapRows * ch;
  const fit = Math.min(availW / gridW, availH / gridH);
  const letterboxed = (scale: number, passive: boolean): ScaleLayoutResult => ({
    scale,
    offsetX: Math.max(0, (availW - gridW * scale) / 2),
    offsetY: Math.max(0, (availH - gridH * scale) / 2),
    passive,
  });
  // Unscaled (scale-1) rendering centers the sub-cell quantization
  // remainder: cols = floor(availW / cellW) leaves up to one cell of
  // slack, and anchoring the grid at the left padding would park ALL
  // of it on the right. Splitting it (floored to whole px so scale-1
  // text stays on the pixel grid) makes the gutters symmetric.
  const centered: ScaleLayoutResult = {
    scale: 1,
    offsetX: Math.floor(Math.max(0, availW - gridW) / 2),
    offsetY: Math.floor(Math.max(0, availH - gridH) / 2),
    passive: false,
  };
  // Pinned branch — REGARDLESS of isActiveViewer (see header). Wins
  // over the pendingResize hold too: while pinned by someone else no
  // resize is emitted, so a stale hold must not stretch a clamped
  // grid. (The companion callsite drops `pinned` while its OWN
  // ephemeral re-claim is in flight, so keyboard reflows still ride
  // the active hold-and-scale path below.)
  if (pinned) {
    if (fit >= 1) return centered;
    return letterboxed(Math.max(fit, PINNED_SCALE_FLOOR), false);
  }
  if (!isActiveViewer) {
    if (fit >= 1) return centered;
    return letterboxed(Math.max(fit, PASSIVE_SCALE_FLOOR), true);
  }
  // Active client, resize in flight (hold-and-scale): frames still
  // carry the OLD geometry — stretch the last grid to the new box
  // (scale may exceed 1 when the box grew) until the first frame at
  // the requested dims lands or the hold times out. This is what
  // turns the container-resize window from a flash into a smooth
  // reflow.
  if (
    pendingResize &&
    (snapCols !== pendingResize.cols || snapRows !== pendingResize.rows)
  ) {
    return letterboxed(Math.max(fit, PASSIVE_SCALE_FLOOR), false);
  }
  return centered;
}
