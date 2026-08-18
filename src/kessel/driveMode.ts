// Phone Drive state machine (PRD D3 / PR4). Desktop `activeViewer.ts`
// is focus/tab ambient — do not import it. Drive is an explicit tap.
//
// Measure-first: `set_mode:claimer` may go out with no dims; `set_active`
// only after `measurePaneFit(contentBoxSize)`. Never the VT 80×24
// spawn fallback — that SIGWINCHes a live desktop TUI.

import type { PaneFit } from "./measurePaneFit";

export type DriveIntent = "watch" | "drive";

export function isUsableFit(
  fit: PaneFit | null | undefined,
): fit is PaneFit {
  return !!fit && fit.cols > 0 && fit.rows > 0;
}

/** Enter Drive. `set_mode:claimer` first; `set_active` only with a
 *  real measure. Null fit → wait a frame; caller must not invent 80×24. */
export function driveEnterFrames(fit: PaneFit | null | undefined): unknown[] {
  const out: unknown[] = [{ action: "set_mode", mode: "claimer" }];
  if (!isUsableFit(fit)) return out;
  out.push({
    action: "set_active",
    active: true,
    cols: fit.cols,
    rows: fit.rows,
  });
  out.push({ action: "resize", cols: fit.cols, rows: fit.rows });
  return out;
}

/** Keyboard / rotate remasure while already Driving. Empty when the
 *  pane is still unmeasurable — do not fall back to 80×24. */
export function driveResizeFrames(fit: PaneFit | null | undefined): unknown[] {
  if (!isUsableFit(fit)) return [];
  return [
    { action: "set_active", active: true, cols: fit.cols, rows: fit.rows },
    { action: "resize", cols: fit.cols, rows: fit.rows },
  ];
}

/** Leave Drive. Viewer + drop the active slot so elect_on_detach /
 *  desktop can take size back. */
export function driveLeaveFrames(): unknown[] {
  return [
    { action: "set_mode", mode: "viewer" },
    { action: "set_active", active: false },
  ];
}

/** Frames on WS open. Watch (Connect `/cli` included) must send
 *  `set_mode:viewer` so an owner socket is not left claimer.
 *  Drive flushes a stored measure as `set_active` — never 80×24. */
export function driveOpenFrames(
  drive: boolean,
  fit: PaneFit | null | undefined,
): unknown[] {
  if (!drive) return [{ action: "set_mode", mode: "viewer" }];
  return driveEnterFrames(fit);
}
