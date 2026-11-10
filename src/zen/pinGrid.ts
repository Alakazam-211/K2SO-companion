// The Agents pin grid's measures, shared with the Home list's first nine.

export const ZEN_LIST_EDGE_INSET = 4;
export const ZEN_LIST_EDGE_PAD = 2;
export const ZEN_PIN_COL_GAP = 37;
export const ZEN_PIN_ROW_GAP = 14;
export const ZEN_PIN_AVATAR_PX = 74;

/** Space under the pin grid, above the first list row (was 8; +6 asked). */
export const ZEN_PIN_GRID_BOTTOM_PX = 14;

/**
 * Pin grid columns for `count` pins. Three or more: three equal columns,
 * a partial last row left-justified. One or two: that many columns of the
 * same 3-column cell width (same gap), centred as a group. `100%` here is
 * the grid's content box, so the cell matches the 3-column `1fr` exactly
 * and the list inset (which assumes three columns) never moves.
 */
export function zenPinGridColumns(count: number): string {
  if (count >= 3) return "repeat(3, minmax(0, 1fr))";
  const n = Math.max(1, count);
  return `repeat(${n}, calc((100% - ${2 * ZEN_PIN_COL_GAP}px) / 3))`;
}
