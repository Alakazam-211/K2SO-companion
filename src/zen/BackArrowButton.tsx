import type { CSSProperties } from "react";

/** The chat header's back chevron. */
export function BackChevron({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/** A page's way back: the glass circle with the chevron (Rosson
 *  2026-11-09), in place of "Done". */
export function BackArrowButton({
  onClick,
  testId,
  label = "Back",
  style,
}: {
  onClick: () => void;
  testId?: string;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className="flex items-center justify-center shrink-0 justify-self-start zen-glass zen-glass-pill"
      style={{ width: 34, height: 34, color: "#fff", ...style }}
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
    >
      <BackChevron />
    </button>
  );
}
