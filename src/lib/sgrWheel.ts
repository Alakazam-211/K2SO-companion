// ── Touch-drag → SGR wheel translation (fullscreen TUIs, T5a) ──────
//
// Mobile twin of the desktop's mouse-reporting wheel branch
// (kessel-term/TerminalPane.tsx onWheel + sgrMouse.ts): when the child
// has DECSET mouse reporting on, it paints its own scrollable surface
// (typically on the alt screen, which has NO scrollback), so local
// viewport scrolling is a no-op. Vertical touch-drag over the terminal
// is translated into SGR wheel reports sent to the PTY instead, and
// the app scrolls itself.
//
// Pure: no DOM — TerminalView's touch effect owns the events;
// everything decidable/encodable lives here so it's unit-testable in
// plain Node (scripts/test-sgr-wheel.mjs).

export interface WheelGate {
  mouseReport?: boolean;
  sgrMouse?: boolean;
}

export type WheelRoute = "forward" | "local";

/** Forward drags to the app, or leave them to the native/shim
 *  scrollback path. EXACTLY the desktop's wheel gate
 *  (`snap?.mouseReport && snap?.sgrMouse`): SGR-only, because legacy
 *  X10 wheel bytes can't ride the JSON text-input channel. altScreen
 *  is deliberately NOT consulted — desktop parity (mouse-report mode
 *  virtually always means alt screen, and a mouse-reporting app on the
 *  primary screen still wants its wheel events). */
export function wheelRoute(gate: WheelGate): WheelRoute {
  return gate.mouseReport && gate.sgrMouse ? "forward" : "local";
}

/** "up" = toward older content (SGR 64), "down" = toward newer (65) —
 *  same mapping as the desktop's deltaY sign. */
export type WheelDir = "up" | "down";

/** One SGR wheel report: `ESC[<64;x;yM` up / `ESC[<65;x;yM` down,
 *  1-based cell coords (byte-exact desktop parity). */
export function encodeSgrWheel(dir: WheelDir, col: number, row: number): string {
  const btn = dir === "up" ? 64 : 65;
  const c = Math.max(1, Math.floor(col));
  const r = Math.max(1, Math.floor(row));
  return `\x1b[<${btn};${c};${r}M`;
}

// ── Drag quantization / rate limiting ──────────────────────────────
//
// One wheel event per cell-height of drag (desktop CELLS_PER_NOTCH
// parity), with the sub-cell remainder carried between touchmove
// events so slow drags still add up. A fast flick gets a velocity
// multiplier (there's no native momentum on this path — the boost is
// the momentum-ish feel), and the whole gesture is capped so a flick
// can never flood the WS / a long-distance K2 Connect link.

/** Higher = less sensitive: one SGR event per ~this many cell-heights
 *  of accumulated drag (desktop CELLS_PER_NOTCH = 1.0). */
export const CELLS_PER_EVENT = 1.0;
/** Hard ceiling of wheel events per touch gesture. */
export const GESTURE_EVENT_CAP = 30;
/** Finger speed (px/ms) at or above which a move counts as a flick. */
export const FLICK_VELOCITY_PX_PER_MS = 1.0;
/** Drag-distance boost applied to flick-speed moves. */
export const FLICK_MULTIPLIER = 3;

export interface DragWheelState {
  /** Sub-cell px carry between touchmove events (signed). */
  accumPx: number;
  /** Wheel events emitted so far THIS gesture (cap bookkeeping). */
  sent: number;
}

/** Fresh per-gesture state — call on touchstart. */
export function initialDragWheel(): DragWheelState {
  return { accumPx: 0, sent: 0 };
}

export interface DragWheelResult {
  /** Whole wheel events to emit now (already capped). */
  ticks: number;
  dir: WheelDir;
  state: DragWheelState;
}

/** Fold one touchmove into the gesture. `deltaPx` is prevY − curY:
 *  positive = finger moved UP = content scrolls up = wheel-down (the
 *  natural direction the existing scrollback shim has). Returns the
 *  capped whole-event count; only the sub-cell remainder carries —
 *  cap-discarded whole ticks are DROPPED, not deferred (deferring
 *  would dump a burst later or park a direction reversal behind
 *  stale carry). */
export function accumulateDrag(
  state: DragWheelState,
  deltaPx: number,
  cellHeightPx: number,
  velocityPxPerMs = 0,
): DragWheelResult {
  if (cellHeightPx <= 0 || !Number.isFinite(deltaPx) || deltaPx === 0) {
    return { ticks: 0, dir: "down", state };
  }
  const boosted =
    Math.abs(velocityPxPerMs) >= FLICK_VELOCITY_PX_PER_MS
      ? deltaPx * FLICK_MULTIPLIER
      : deltaPx;
  const accum = state.accumPx + boosted;
  const eventPx = cellHeightPx * CELLS_PER_EVENT;
  const whole = Math.floor(Math.abs(accum) / eventPx);
  const dir: WheelDir = accum > 0 ? "down" : "up";
  const budget = Math.max(0, GESTURE_EVENT_CAP - state.sent);
  const ticks = Math.min(whole, budget);
  const remainder = Math.sign(accum) * (Math.abs(accum) - whole * eventPx);
  return {
    ticks,
    dir,
    state: { accumPx: remainder, sent: state.sent + ticks },
  };
}

// ── Touch point → 1-based SGR cell ─────────────────────────────────

export interface CellPointInput {
  /** Touch point in the scroll container's CONTENT space
   *  (clientX/Y − container rect + scrollLeft/Top). */
  x: number;
  y: number;
  /** scaleLayout transform of the painted strip. */
  offsetX: number;
  scale: number;
  /** UNSCALED cell metrics + live grid dims. */
  cellW: number;
  cellH: number;
  cols: number;
  viewportRows: number;
  totalRows: number;
  /** Strip padding (TerminalView paints at left 4+offsetX / top 4+offsetY). */
  padX?: number;
  padY?: number;
}

/** The finger's grid cell, clamped into the viewport — the SGR
 *  coordinate every wheel report of the gesture carries (desktop
 *  sends the pointer's cell). SGR rows address VIEWPORT cells; the
 *  strip stacks scrollback ABOVE the viewport, so its rows are
 *  subtracted (mouse-report mode virtually always means alt screen ⇒
 *  no scrollback ⇒ identity — same reasoning as the desktop's
 *  scrollPx subtraction). */
export function cellFromPoint(p: CellPointInput): { col: number; row: number } {
  if (p.cellW <= 0 || p.cellH <= 0) return { col: 1, row: 1 };
  const s = p.scale > 0 ? p.scale : 1;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const col = clamp(
    Math.floor((p.x - (p.padX ?? 8) - p.offsetX) / (p.cellW * s)) + 1,
    1,
    Math.max(1, p.cols),
  );
  const stripRow = Math.floor((p.y - (p.padY ?? 4)) / (p.cellH * s));
  const sb = Math.max(0, p.totalRows - p.viewportRows);
  const row = clamp(stripRow - sb + 1, 1, Math.max(1, p.viewportRows));
  return { col, row };
}
