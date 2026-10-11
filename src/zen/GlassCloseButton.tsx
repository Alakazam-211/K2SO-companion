/** The drawers' close control: a 28px glass pill with an X, inside a 44x44
 *  hit target. The negative margins keep the pill spaced like its 28px
 *  neighbours. Used by the Files and Sessions drawers. */
export function GlassCloseButton({
  onClick,
  label,
  testId,
}: {
  onClick: () => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center shrink-0"
      style={{ width: 44, height: 44, marginLeft: -6, marginRight: -6, color: "#fff" }}
      aria-label={label}
      data-testid={testId}
    >
      <span
        className="flex items-center justify-center zen-glass zen-glass-pill"
        style={{ width: 28, height: 28 }}
        aria-hidden
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </span>
    </button>
  );
}
