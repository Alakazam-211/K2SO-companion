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

      {/* Session switcher — top right */}
      <button
        onClick={onSessionSwitch}
        className="ml-auto flex items-center gap-1.5 shrink-0 border border-[var(--border)] px-2 py-1 hover:border-[var(--accent-dim)] hover:text-[var(--accent)] transition-all duration-150 text-[var(--text-muted)]"
      >
        <span className="text-[10px] font-bold">⌘J</span>
      </button>
    </div>
  );
}
