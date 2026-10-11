/** The `＋` drawn by the composer's attach button. Shared with the
 *  Agents / Servers bottom bar so both pluses stay identical. */
export const PLUS_GLYPH = "＋";
export const PLUS_GLYPH_PX = 22;

export function PlusGlyph() {
  return (
    <span
      aria-hidden="true"
      data-testid="plus-glyph"
      style={{
        fontSize: PLUS_GLYPH_PX,
        lineHeight: 1,
        color: "var(--text-muted)",
      }}
    >
      {PLUS_GLYPH}
    </span>
  );
}
