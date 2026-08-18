// Drive-only SGR wheel (buttons 64/65). Matches Kessel TerminalPane:
// rAF flush, 32-notch cap, overflow dropped, sub-notch remainder kept.
// Watch never emits — any grid `{action:"input"}` is a claim.

export const MAX_NOTCHES_PER_FLUSH = 32
export const CELLS_PER_NOTCH = 1.0

export interface SgrWheelGate {
  /** Explicit Drive. False/absent ⇒ never send (Watch default). */
  drive?: boolean
  mouseReport?: boolean
  sgrMouse?: boolean
}

/** SGR only when Drive is already on the socket AND the child asked
 *  for SGR mouse. Watch + alt-screen must not inject. */
export function canSendSgrWheel(gate: SgrWheelGate): boolean {
  return gate.drive === true && !!gate.mouseReport && !!gate.sgrMouse
}

export type WheelDir = 'up' | 'down'

/** `ESC[<64;x;yM` up / `ESC[<65;x;yM` down. 1-based cells. */
export function encodeSgrWheel(dir: WheelDir, col: number, row: number): string {
  const btn = dir === 'up' ? 64 : 65
  const c = Math.max(1, Math.floor(col))
  const r = Math.max(1, Math.floor(row))
  return `\x1b[<${btn};${c};${r}M`
}

export interface WheelPumpState {
  accumPx: number
}

export function initialWheelPump(): WheelPumpState {
  return { accumPx: 0 }
}

/** Fold one delta into the pump. A sign flip clears the old remainder
 *  so the first counter-swipe responds immediately (iTerm2). */
export function accumulateWheelPx(
  state: WheelPumpState,
  deltaPx: number,
): WheelPumpState {
  if (!Number.isFinite(deltaPx) || deltaPx === 0) return state
  if (
    state.accumPx !== 0 &&
    Math.sign(deltaPx) !== Math.sign(state.accumPx)
  ) {
    return { accumPx: deltaPx }
  }
  return { accumPx: state.accumPx + deltaPx }
}

export interface WheelFlushResult {
  ticks: number
  dir: WheelDir
  /** Empty when ticks === 0. Else one CSI × ticks (one write). */
  seq: string
  state: WheelPumpState
}

/** Convert accumulated px into ≤32 notches. Overflow past the cap is
 *  dropped; only the sub-notch remainder carries. */
export function flushWheelNotches(
  state: WheelPumpState,
  cellHeight: number,
  col: number,
  row: number,
): WheelFlushResult {
  const accum = state.accumPx
  const dir: WheelDir = accum < 0 ? 'up' : 'down'
  if (cellHeight <= 0 || !Number.isFinite(accum) || accum === 0) {
    return { ticks: 0, dir, seq: '', state }
  }
  const notchPx = cellHeight * CELLS_PER_NOTCH
  if (notchPx <= 0) return { ticks: 0, dir, seq: '', state }
  let ticks = Math.floor(Math.abs(accum) / notchPx)
  if (ticks === 0) return { ticks: 0, dir, seq: '', state }
  let nextAccum: number
  if (ticks > MAX_NOTCHES_PER_FLUSH) {
    ticks = MAX_NOTCHES_PER_FLUSH
    nextAccum = Math.sign(accum) * (Math.abs(accum) % notchPx)
  } else {
    nextAccum = accum - Math.sign(accum) * ticks * notchPx
  }
  return {
    ticks,
    dir,
    seq: encodeSgrWheel(dir, col, row).repeat(ticks),
    state: { accumPx: nextAccum },
  }
}

/** One-or-more CSI SGR wheel reports (`ESC[<64;` / `ESC[<65;`).
 *  Tap/motion (`<0;` / `<32;`) and any other input are rejected. */
const SGR_WHEEL_CSI = /^(?:\x1b\[<(?:64|65);\d+;\d+M)+$/

/** Grid `{action:"input"}` frames. Empty unless Drive is on AND
 *  `text` is wheel CSI 64/65 — Watch must not send, and this must
 *  never go through terminal.write (handle_write appends \\r). */
export function sgrInputActions(
  drive: boolean,
  text: string,
): ReadonlyArray<{ action: 'input'; text: string }> {
  if (!drive || !text || !SGR_WHEEL_CSI.test(text)) return []
  return [{ action: 'input', text }]
}

export interface CellPointInput {
  x: number
  y: number
  offsetX: number
  offsetY?: number
  scale: number
  cellW: number
  cellH: number
  cols: number
  viewportRows: number
  padX?: number
  padY?: number
  /** From-bottom pixel scroll. Alt-screen clamps to 0 ⇒ identity. */
  scrollPx?: number
}

/** Finger → 1-based SGR cell. Maps through scale/offset then subtracts
 *  `scrollPx` (desktop TerminalPane), not a stacked-scrollback strip. */
export function cellFromPoint(p: CellPointInput): { col: number; row: number } {
  if (p.cellW <= 0 || p.cellH <= 0) return { col: 1, row: 1 }
  const s = p.scale > 0 ? p.scale : 1
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v))
  const col = clamp(
    Math.floor((p.x - (p.padX ?? 4) - p.offsetX) / (p.cellW * s)) + 1,
    1,
    Math.max(1, p.cols),
  )
  const localY = (p.y - (p.padY ?? 4) - (p.offsetY ?? 0)) / s
  const row = clamp(
    Math.floor((localY - (p.scrollPx ?? 0)) / p.cellH) + 1,
    1,
    Math.max(1, p.viewportRows),
  )
  return { col, row }
}
