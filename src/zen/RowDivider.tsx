/** The time + chevron grey; the divider matches it (Rosson 2026-10-18). */
export const ROW_DIVIDER_COLOR = "#8e8e93";
/** Avatar (50px) + the row's gap (10px): where the text column starts. */
export const ROW_DIVIDER_AVATAR_OFFSET = 60;

/**
 * The hairline between two agent rows (Home, Agents, other servers' rows).
 * It sits at the bottom of the row's own (relative) wrapper, so it moves
 * with the row in a Rearrange drag. It runs from the text column (row
 * left padding + avatar + gap) to the chevron's right edge (row right
 * padding). Lists render it on every row but the last of a section.
 */
export function RowDivider({
  padLeft,
  padRight,
  transition,
}: {
  /** The row's padding-left (CSS), Rearrange room included. */
  padLeft: string;
  /** The row's padding-right (CSS): where the chevron ends. */
  padRight: string;
  /** Follows the row's padding-left animation, when it has one. */
  transition?: string;
}) {
  return (
    <span
      aria-hidden
      data-testid="row-divider"
      className="absolute pointer-events-none"
      style={{
        left: `calc(${padLeft} + ${ROW_DIVIDER_AVATAR_OFFSET}px)`,
        right: padRight,
        bottom: 0,
        // 1px scaled to half: a crisp hairline in WKWebView.
        height: 1,
        transform: "scaleY(.5)",
        transformOrigin: "bottom",
        background: ROW_DIVIDER_COLOR,
        transition,
      }}
    />
  );
}
