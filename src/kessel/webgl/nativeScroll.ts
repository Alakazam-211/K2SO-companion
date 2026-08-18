// Native overflow → computeStripLayout `scrollPx`.
//
// The shell is `originY + totalRows·cellH·scale`. Watch letterbox
// puts `offsetY` into originY, so (overflow / scale) is NOT
// maxScrollPx — lerp the clamped thumb onto [0, maxScrollPx] instead.

import { clampScrollPx, maxScrollPx } from '../scrollMath'

/** Map native overflow scroll onto CSS-px-above-bottom `scrollPx`. */
export function nativeScrollToPx(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  scrollbackLen: number,
  cellHeight: number,
): number {
  const max = maxScrollPx(scrollbackLen, cellHeight)
  const overflow = scrollHeight - clientHeight
  if (!(max > 0) || !(overflow > 0)) return 0
  const t = Math.min(1, Math.max(0, scrollTop / overflow))
  return clampScrollPx((1 - t) * max, scrollbackLen, cellHeight)
}
