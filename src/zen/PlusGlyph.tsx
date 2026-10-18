/** The `＋` drawn by the composer's attach button. Shared with the
 *  Agents / Servers bottom bar so both pluses stay identical. */
export const PLUS_GLYPH = "＋";
export const PLUS_GLYPH_PX = 22;

/** `bright`: white, like the header bubbles' icons (the Agents / Servers
 *  bottom bar, Rosson 2026-10-18). The composer keeps the muted plus. */
export function PlusGlyph({ bright = false }: { bright?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="plus-glyph"
      style={{
        fontSize: PLUS_GLYPH_PX,
        lineHeight: 1,
        color: bright ? "#fff" : "var(--text-muted)",
      }}
    >
      {PLUS_GLYPH}
    </span>
  );
}
