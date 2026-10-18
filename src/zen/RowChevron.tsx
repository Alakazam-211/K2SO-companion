/** The ›  that ends an agent row (Home, Agents): an SVG chevron sized to
 *  read at a glance (the `›` glyph was too small, Rosson 2026-10-18). */
export function RowChevron() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-testid="row-chevron"
      style={{ flexShrink: 0 }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
