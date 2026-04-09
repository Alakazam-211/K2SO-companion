import { useWorkspacesStore } from "../stores/workspaces";

interface Props {
  onMenuOpen: () => void;
  onSessionSwitch: () => void;
}

export function HeaderBar({ onMenuOpen, onSessionSwitch }: Props) {
  const activeWorkspace = useWorkspacesStore((s) => {
    const { workspaces, activeWorkspaceId } = s;
    return workspaces.find((w) => w.id === activeWorkspaceId);
  });

  return (
    <div className="flex items-center px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 gap-3">
      {/* Hamburger — matches K2SO website pattern */}
      <button
        onClick={onMenuOpen}
        className="flex flex-col justify-center items-center w-8 h-8 gap-[5px] bg-[var(--accent)] shrink-0"
      >
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
        <span className="block h-[2px] w-4 bg-[var(--background)]" />
      </button>

      {/* Active workspace */}
      {activeWorkspace ? (
        <>
          <span
            className="w-4 h-4 flex items-center justify-center text-[8px] font-bold text-black shrink-0"
            style={{ background: activeWorkspace.color }}
          >
            {activeWorkspace.name.charAt(0).toUpperCase()}
          </span>
          <span className="text-[var(--text)] text-[13px] font-semibold truncate">
            {activeWorkspace.name}
          </span>
        </>
      ) : (
        <span className="text-[var(--text-muted)] text-[13px]">No workspace</span>
      )}

      {/* Session switcher — stacked terminals icon */}
      <button
        onClick={onSessionSwitch}
        className="ml-auto shrink-0 w-8 h-8 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors duration-150"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="5" width="12" height="10" rx="1" />
          <path d="M5 5V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7" />
          <path d="M6 9h4" strokeLinecap="round" />
          <path d="M6 12h2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
