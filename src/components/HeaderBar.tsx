import { useWorkspacesStore } from "../stores/workspaces";

interface Props {
  onMenuOpen: () => void;
  onSessionSwitch: () => void;
  onSearch: () => void;
}

export function HeaderBar({ onMenuOpen, onSessionSwitch, onSearch }: Props) {
  const activeProject = useWorkspacesStore((s) => s.activeProject());
  const summary = useWorkspacesStore((s) =>
    s.activeProjectId ? s.summaryFor(s.activeProjectId) : undefined
  );
  const totalSessions = useWorkspacesStore((s) => s.allSessions.length);

  return (
    <div className="flex items-center px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 gap-3">
      {/* Hamburger */}
      <button
        onClick={onMenuOpen}
        className="flex flex-col justify-center items-center w-8 h-8 gap-[5px] bg-[var(--accent)] shrink-0"
      >
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
      </button>

      {/* Active workspace */}
      {activeProject ? (
        <>
          <span
            className="w-4 h-4 flex items-center justify-center text-[8px] font-bold text-black shrink-0"
            style={{ background: activeProject.color }}
          >
            {activeProject.name.charAt(0).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-[var(--text)] text-[13px] font-semibold block truncate">
              {activeProject.name}
            </span>
            {summary && summary.agentsRunning > 0 && (
              <span className="text-[var(--success)] text-[9px]">
                {summary.agentsRunning} running
              </span>
            )}
          </div>
        </>
      ) : (
        <span className="text-[var(--text-muted)] text-[13px] flex-1">No workspace</span>
      )}

      {/* Search */}
      <button
        onClick={onSearch}
        className="shrink-0 w-8 h-8 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors duration-150"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      {/* Session switcher */}
      <button
        onClick={onSessionSwitch}
        className="relative shrink-0 w-8 h-8 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors duration-150"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="5" width="12" height="10" rx="1" />
          <path d="M5 5V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7" />
          <path d="M6 9h4" strokeLinecap="round" />
          <path d="M6 12h2" strokeLinecap="round" />
        </svg>
        {totalSessions > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-[var(--accent)] text-black text-[7px] font-bold flex items-center justify-center">
            {totalSessions}
          </span>
        )}
      </button>
    </div>
  );
}
