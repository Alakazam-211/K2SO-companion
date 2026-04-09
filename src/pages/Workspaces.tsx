import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgentsStore } from "../stores/agents";
import { useWorkspacesStore } from "../stores/workspaces";
import * as api from "../api/client";
import type { Agent } from "../api/client";

export function Workspaces() {
  const { runningAgents, agents, isLoading, refreshForProject, startListening } =
    useAgentsStore();
  const activeProject = useWorkspacesStore((s) => s.activeProject());
  const summary = useWorkspacesStore((s) =>
    s.activeProjectId ? s.summaryFor(s.activeProjectId) : undefined
  );
  const navigate = useNavigate();
  const [showLaunch, setShowLaunch] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    if (activeProject) {
      refreshForProject(activeProject.path);
      return startListening(activeProject.path);
    }
  }, [activeProject?.id]);

  const launchableAgents = agents.filter(
    (a) => !runningAgents.some((r) => r.name === a.name)
  );

  const handleLaunch = async (agent: Agent) => {
    if (!activeProject) return;
    setLaunching(agent.name);
    await api.wakeAgent(activeProject.path, agent.name);
    setShowLaunch(false);
    setLaunching(null);
    setTimeout(() => refreshForProject(activeProject.path), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
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
                  <div className="text-[var(--text)] text-lg font-bold">{agents.length}</div>
                  <div className="text-[var(--text-muted)] text-[9px]">Agents</div>
                </div>
                <div className="w-px bg-[var(--border)]" />
                <div className="flex-1 text-center">
                  <div className="text-[var(--text)] text-lg font-bold">{summary.reviewsPending}</div>
                  <div className="text-[var(--text-muted)] text-[9px]">Reviews</div>
                </div>
              </div>
            )}

            {/* Active sessions header */}
            <div className="flex items-center justify-between mb-3">
              <p className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
                Active Sessions
              </p>
              {launchableAgents.length > 0 && (
                <button
                  onClick={() => setShowLaunch(!showLaunch)}
                  className="text-[var(--accent)] text-[11px] font-semibold border border-[var(--accent-dim)] px-2.5 py-1 hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-all"
                >
                  + New Session
                </button>
              )}
            </div>

            {/* Launch agent picker */}
            {showLaunch && (
              <div className="border border-[var(--border)] bg-[var(--surface)] p-3 mb-3">
                <p className="text-[var(--text-muted)] text-[10px] mb-2">Select an agent to launch:</p>
                {launchableAgents.map((agent) => (
                  <button
                    key={agent.name}
                    onClick={() => handleLaunch(agent)}
                    disabled={launching === agent.name}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 mb-1 border border-[var(--border)] hover:border-[var(--accent-dim)] transition-all text-left"
                  >
                    <span className="text-[var(--text)] text-[11px] font-medium flex-1">
                      {agent.name}
                    </span>
                    <span className="text-[var(--text-muted)] text-[10px] truncate max-w-[50%]">
                      {agent.role}
                    </span>
                    {launching === agent.name && (
                      <span className="text-[var(--warning)] text-[9px] shrink-0">Launching...</span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => setShowLaunch(false)}
                  className="text-[var(--text-muted)] text-[10px] mt-1"
                >
                  Cancel
                </button>
              </div>
            )}

            {isLoading && runningAgents.length === 0 ? (
              <p className="text-[var(--text-muted)] text-[13px] text-center pt-12">Loading...</p>
            ) : runningAgents.length === 0 && !showLaunch ? (
              <div className="text-center pt-12">
                <p className="text-[var(--text-secondary)] text-[13px]">No active sessions</p>
                <p className="text-[var(--text-muted)] text-[11px] mt-1">
                  Tap "+ New Session" to launch an agent
                </p>
              </div>
            ) : (
              runningAgents.map((agent) => (
                <button
                  key={agent.terminal_id}
                  onClick={() => navigate(`/chat/${agent.terminal_id}`)}
                  className="w-full text-left bg-[var(--surface)] border border-[var(--border)] p-4 mb-2 transition-all duration-150 hover:border-[var(--border-hover)]"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" />
                    <span className="text-[var(--text)] text-[13px] font-semibold flex-1 truncate">
                      {agent.name}
                    </span>
                    <span className="text-[var(--text-muted)] text-[10px] shrink-0">
                      {agent.terminal_id}
                    </span>
                  </div>
                  {agent.started_at && (
                    <p className="text-[var(--text-muted)] text-[10px] mt-1 ml-4">
                      Started {new Date(agent.started_at).toLocaleTimeString()}
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
