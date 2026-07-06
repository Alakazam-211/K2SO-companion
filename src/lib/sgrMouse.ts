// ── Tap → SGR mouse click for mouse-reporting TUIs (T5b) ───────────
//
// Mobile twin of the desktop's button-forwarding branch
// (kessel-term/sgrMouse.ts + TerminalPane's pointer effect): with
// DECSET mouse reporting + SGR encoding on, TUI menus/buttons expect
// real mouse clicks. A TAP (single touch, <10px movement, <300ms)
// becomes a left-button press+release pair at the tapped cell —
// byte-exact desktop parity (`encodeSgrMouse(0,'press'|'release')`:
// press final `M`, release final `m` WITH the real button code, which
// is why the gate requires SGR ?1006).
//
// Touch has no middle/right button, no ctrl and no hover, so the
// desktop's modifier/motion machinery collapses to button 0 with no
// +16/+32 additions. Gesture DISAMBIGUATION also lives here (pure,
// scripts/test-sgr-mouse.mjs): movement beyond the threshold makes a
// drag (T5a's wheel path owns it), holding past LONG_PRESS_MS makes a
// long-press (touchSelect.ts selection owns it), and only a short
// still touch is a tap.

export interface MouseGate {
  mouseReport?: boolean;
  sgrMouse?: boolean;
}

export type MouseRoute = "forward" | "local";

/** Forward taps to the app, or leave them local (Direct-mode focus,
 *  scrollback). EXACTLY the wheel gate (`mouseReport && sgrMouse`,
 *  desktop `mouseRoute` minus the modifier cases touch can't carry):
 *  SGR-only, because legacy X10 bytes can't ride the JSON input
 *  channel. */
export function mouseRoute(gate: MouseGate): MouseRoute {
  return gate.mouseReport && gate.sgrMouse ? "forward" : "local";
}

export type SgrKind = "press" | "release";

/** Encode one SGR left-button report at a 1-based cell. Press uses the
 *  `M` final, release the `m` final with the SAME button code
 *  (desktop encodeSgrMouse with button 0, no ctrl, no motion). */
export function encodeSgrMouse(kind: SgrKind, col: number, row: number): string {
  const c = Math.max(1, Math.floor(col));
  const r = Math.max(1, Math.floor(row));
  return `\x1b[<0;${c};${r}${kind === "release" ? "m" : "M"}`;
}

/** One full tap-click: press immediately followed by release at the
 *  same cell. The desktop sends the halves on pointerdown/pointerup;
 *  a tap has no meaningful in-between, so both ride ONE input frame
 *  (same batching idea as the wheel path's `repeat(ticks)` flush). */
export function encodeSgrTap(col: number, row: number): string {
  return encodeSgrMouse("press", col, row) + encodeSgrMouse("release", col, row);
}

// ── Gesture disambiguation (tap / drag / long-press) ───────────────
//
// One shared movement threshold keeps the three gestures mutually
// exclusive: movement past it CANCELS both tap and long-press (the
// drag→wheel path owns the touch from there); the long-press timer
// firing first CANCELS tap and wheel (selection owns the touch);
// a short still release is the only tap.

/** Movement ceiling for tap AND long-press (px, straight-line). */
export const TAP_MAX_MOVE_PX = 10;
/** A still touch released within this window is a tap… */
export const TAP_MAX_MS = 300;
/** …and one held this long (still) becomes a long-press. Between the
 *  two is a deliberate dead zone — neither click nor selection. */
export const LONG_PRESS_MS = 500;

export interface GestureStart {
  x: number;
  y: number;
  /** touchstart timestamp (ms). */
  t: number;
}

/** Has the touch strayed beyond the tap/long-press movement ceiling? */
export function movedBeyond(
  start: GestureStart,
  x: number,
  y: number,
  thresholdPx: number = TAP_MAX_MOVE_PX,
): boolean {
  const dx = x - start.x;
  const dy = y - start.y;
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}

export type GestureKind = "tap" | "drag" | "long-press" | "none";

/** Classify the gesture at touchend. `moved` = any move beyond the
 *  threshold during the touch; `longPressFired` = the LONG_PRESS_MS
 *  timer fired while still. Long-press wins over a later move (the
 *  selection is already live — the move was adjusting it). */
export function classifyRelease(opts: {
  moved: boolean;
  longPressFired: boolean;
  durationMs: number;
}): GestureKind {
  if (opts.longPressFired) return "long-press";
  if (opts.moved) return "drag";
  if (opts.durationMs < TAP_MAX_MS) return "tap";
  return "none";
}
