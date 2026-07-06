// PLACEHOLDER — slice C2 replaces this file with the real Projects page
// (project-group list for the ACTIVE server + PoC chat + HTML-docs browser;
// see PRD §2). The `/projects` route + tab already exist so C2 only swaps
// the component.

export function ProjectsPlaceholder() {
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
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
      <h1 className="text-[var(--text)] text-[14px] font-semibold">Projects</h1>
      <p className="text-[var(--text-muted)] text-[11px] text-center leading-5">
        Coming in the next slice.
      </p>
    </div>
  );
}
