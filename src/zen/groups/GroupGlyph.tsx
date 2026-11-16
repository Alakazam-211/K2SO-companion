// One Home group's mark (K2 0.46.13): its Lucide icon, drawn squared like
// desktop's group glyphs (square caps, mitred joins, currentColor), or the
// group's position number when it has none or this build doesn't know its
// name (never a broken glyph). No per-group colour: the caller sets the ink
// (the current group's accent, the others muted).

import { groupIcon } from "./groupIcons";

/** The app's icon stroke on the 24 grid. */
export const GROUP_GLYPH_STROKE = 1.75;

/** The bare number's size beside `px` glyphs (desktop: 12 px bold beside
 *  14 px; it scales with the glyph). */
export function groupNumeralPx(px: number): number {
  return Math.round(px * 0.86);
}

export function GroupGlyph({
  icon,
  n,
  size,
  testId,
}: {
  /** The stored Lucide name, or null / undefined for none. */
  icon: string | null | undefined;
  /** The group's 1-based position (drawn when there is no drawable icon). */
  n: number;
  size: number;
  testId?: string;
}) {
  const def = groupIcon(icon);
  if (def) {
    const Icon = def.Icon;
    return (
      <Icon
        size={size}
        strokeWidth={GROUP_GLYPH_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        color="currentColor"
        aria-hidden="true"
        focusable="false"
        data-group-icon={def.name}
        data-testid={testId}
        className="block shrink-0"
      />
    );
  }
  return (
    <span
      aria-hidden
      data-group-numeral={n}
      data-testid={testId}
      className="block font-bold leading-none"
      style={{ fontSize: groupNumeralPx(size), fontVariantNumeric: "tabular-nums" }}
    >
      {n}
    </span>
  );
}

/** "No icon" in the picker: the outlined dot with the number in it. */
export function GroupDot({ n, size }: { n: number; size: number }) {
  const two = String(n).length > 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={GROUP_GLYPH_STROKE}
      aria-hidden="true"
      focusable="false"
      data-group-dot={n}
      className="block shrink-0"
    >
      <circle cx="12" cy="12" r="9.5" />
      <text
        x="12"
        y={two ? 15.6 : 16.2}
        textAnchor="middle"
        fontSize={two ? 10 : 12}
        letterSpacing={two ? -0.6 : undefined}
        fontWeight={700}
        fill="currentColor"
        stroke="none"
      >
        {n}
      </text>
    </svg>
  );
}
