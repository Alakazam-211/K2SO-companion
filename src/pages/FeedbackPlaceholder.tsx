// PLACEHOLDER — slice C3 replaces this file with the real Feedback page
// (feedback items for the ACTIVE server + thread view + comment/resolve;
// see PRD §3). The `/feedback` route + tab already exist so C3 only swaps
// the component.

export function FeedbackPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 gap-3">
      <svg
        width="36"
        height="36"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <h1 className="text-[var(--text)] text-[14px] font-semibold">Feedback</h1>
      <p className="text-[var(--text-muted)] text-[11px] text-center leading-5">
        Coming in the next slice.
      </p>
    </div>
  );
}
