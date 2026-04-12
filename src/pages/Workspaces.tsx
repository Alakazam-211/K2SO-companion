import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAgentsStore } from "../stores/agents";
import { useWorkspacesStore } from "../stores/workspaces";

export function Workspaces() {
  const { runningTerminals, isLoading, refreshForProject, startListening } =
    useAgentsStore();
  const activeProject = useWorkspacesStore((s) => s.activeProject());
  const summary = useWorkspacesStore((s) =>
    s.activeProjectId ? s.summaryFor(s.activeProjectId) : undefined
  );
  const error = useWorkspacesStore((s) => s.error);
  const navigate = useNavigate();

  useEffect(() => {
    useAgentsStore.setState({ agents: [], runningTerminals: [] });
    if (activeProject) {
      refreshForProject(activeProject.path);
      return startListening(activeProject.path);
    }
  }, [activeProject?.id]);

  return (
    <div className="flex flex-col h-full pb-safe">
      <div className="flex-1 overflow-y-auto p-4">
        {/* Error + retry */}
        {error && (
          <div className="mb-4 p-3 border border-[var(--error)]/30">
            <p className="text-[var(--error)] text-[11px] mb-2">{error}</p>
            <button
              onClick={() => useWorkspacesStore.getState().refreshAll()}
              className="text-[var(--accent)] text-[11px] font-semibold border border-[var(--accent-dim)] px-3 py-1 hover:border-[var(--accent)] transition-all"
            >
              Retry
            </button>
          </div>
        )}

        {!activeProject ? (
          <div className="text-center pt-16">
            <p className="text-[var(--text-secondary)] text-[13px]">No workspace selected</p>
            <p className="text-[var(--text-muted)] text-[11px] mt-1">
              Open the menu to pick a workspace
            </p>
          </div>
        ) : (
          <>
            {/* Workspace info bar */}
            {summary && (
              <div className="flex gap-3 mb-4 border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex-1 text-center">
                  <div className="text-[var(--text)] text-lg font-bold">{summary.agentsRunning}</div>
                  <div className="text-[var(--text-muted)] text-[9px]">Running</div>
                </div>
                <div className="w-px bg-[var(--border)]" />
                <div className="flex-1 text-center">
                  <div className="text-[var(--text)] text-lg font-bold">{runningTerminals.length}</div>
                  <div className="text-[var(--text-muted)] text-[9px]">Terminals</div>
                </div>
                <div className="w-px bg-[var(--border)]" />
                <div className="flex-1 text-center">
                  <div className="text-[var(--text)] text-lg font-bold">{summary.reviewsPending}</div>
                  <div className="text-[var(--text-muted)] text-[9px]">Reviews</div>
                </div>
              </div>
            )}

            {/* Active terminals */}
            <p className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase mb-3">
              Active Terminals
            </p>

            {isLoading && runningTerminals.length === 0 ? (
              <p className="text-[var(--text-muted)] text-[13px] text-center pt-12">Loading...</p>
            ) : runningTerminals.length === 0 ? (
              <div className="text-center pt-12">
                <p className="text-[var(--text-secondary)] text-[13px]">No active terminals</p>
                <p className="text-[var(--text-muted)] text-[11px] mt-1">
                  Terminals running in {activeProject.name} will appear here
                </p>
              </div>
            ) : (
              runningTerminals.map((terminal) => (
                <button
                  key={terminal.terminalId}
                  onClick={() => navigate(`/chat/${terminal.terminalId}`)}
                  className="w-full text-left bg-[var(--surface)] border border-[var(--border)] p-4 mb-2 transition-all duration-150 hover:border-[var(--border-hover)]"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" />
                    <span className="text-[var(--text)] text-[13px] font-semibold flex-1 truncate">
                      {terminal.cwd.split("/").pop() || "terminal"}
                    </span>
                  </div>
                  {terminal.command && (
                    <p className="text-[var(--text-muted)] text-[10px] mt-1 ml-4 truncate">
                      {terminal.command}
                    </p>
                  )}
                </button>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
