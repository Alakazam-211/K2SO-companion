import { useWorkspacesStore } from "../stores/workspaces";
import type { Workspace } from "../api/client";

const statusColors: Record<string, string> = {
  working: "var(--accent)",
  permission: "var(--error)",
  review: "var(--success)",
  idle: "transparent",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WorkspaceDrawer({ open, onClose }: Props) {
  const { workspaces, activeWorkspaceId, setActive } = useWorkspacesStore();

  if (!open) return null;

  const handleSelect = (id: string) => {
    setActive(id);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed top-0 left-0 bottom-0 w-[280px] bg-[var(--background)] border-r border-[var(--border)] z-50 flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <span className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
            Workspaces
          </span>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] text-[13px] hover:text-[var(--text)] transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {workspaces.map((w) => (
            <WorkspaceItem
              key={w.id}
              workspace={w}
              isActive={w.id === activeWorkspaceId}
              onSelect={() => handleSelect(w.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function WorkspaceItem({ workspace, isActive, onSelect }: {
  workspace: Workspace; isActive: boolean; onSelect: () => void;
}) {
  const statusColor = workspace.agent_status ? statusColors[workspace.agent_status] : undefined;
  const hasStatus = statusColor && workspace.agent_status !== "idle";

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 px-3 py-3 transition-all duration-150 ${
        isActive
          ? "bg-white/[0.08] text-[var(--text)]"
          : "text-[var(--text-secondary)] hover:bg-white/[0.04]"
      }`}
    >
      {workspace.icon_url ? (
        <img src={workspace.icon_url} alt="" className="w-5 h-5 shrink-0" />
      ) : (
        <span
          className="w-5 h-5 shrink-0 flex items-center justify-center text-[9px] font-bold text-black"
          style={{ background: workspace.color }}
        >
          {workspace.name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-[12px] font-medium flex-1 truncate text-left">
        {workspace.name}
      </span>
      {hasStatus && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: statusColor }}
        />
      )}
      {workspace.agents_running > 0 && (
        <span className="text-[9px] text-[var(--success)] shrink-0">
          {workspace.agents_running} running
        </span>
      )}
    </button>
  );
}
