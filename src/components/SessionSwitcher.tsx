import { useWorkspacesStore } from "../stores/workspaces";
import { useNavigate } from "react-router-dom";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionSwitcher({ open, onClose }: Props) {
  const { allSessions } = useWorkspacesStore();
  const navigate = useNavigate();

  if (!open) return null;

  const handleSelect = (terminalId: string) => {
    onClose();
    navigate(`/chat/${terminalId}`);
  };

  // Group sessions by workspace
  const grouped = allSessions.reduce<Record<string, typeof allSessions>>((acc, s) => {
    if (!acc[s.workspace_name]) acc[s.workspace_name] = [];
    acc[s.workspace_name].push(s);
    return acc;
  }, {});

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--background)] border-t border-[var(--border)] max-h-[70vh] flex flex-col">
        {/* Handle */}
        <div className="flex items-center justify-center py-2 shrink-0">
          <div className="w-10 h-1 bg-[var(--border)] rounded-full" />
        </div>

        <div className="px-4 pb-1 flex items-center justify-between shrink-0">
          <span className="text-[var(--text)] text-[13px] font-semibold">Active Sessions</span>
          <span className="text-[var(--text-muted)] text-[10px]">
            {allSessions.length} session{allSessions.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {allSessions.length === 0 ? (
            <p className="text-[var(--text-muted)] text-[11px] text-center py-8">
              No active sessions across any workspace
            </p>
          ) : (
            Object.entries(grouped).map(([workspace, sessions]) => (
              <div key={workspace} className="mt-3">
                <span className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
                  {workspace}
                </span>
                <div className="mt-1 space-y-1">
                  {sessions.map((s) => (
                    <button
                      key={s.terminal_id}
                      onClick={() => handleSelect(s.terminal_id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] transition-all duration-150 hover:border-[var(--border-hover)] text-left"
                    >
                      <div
                        className="w-1 h-6 shrink-0"
                        style={{ background: s.workspace_color }}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-[var(--text)] text-[11px] font-medium block truncate">
                          {s.agent_name}
                        </span>
                        <span className="text-[var(--text-muted)] text-[9px] block">
                          {s.terminal_id}
                        </span>
                      </div>
                      <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
