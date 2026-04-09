import { useState } from "react";
import { useWorkspacesStore } from "../stores/workspaces";
import type { Project } from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WorkspaceDrawer({ open, onClose }: Props) {
  const {
    activeProjectId,
    activeFocusGroupId,
    searchQuery,
    setActiveProject,
    setActiveFocusGroup,
    setSearchQuery,
    agentProjects,
    pinnedProjects,
    focusGroupProjects,
    filteredProjects,
    focusGroups,
    summaryFor,
    projects,
    isLoading,
    error,
  } = useWorkspacesStore();

  const [searching, setSearching] = useState(false);

  if (!open) return null;

  const handleSelect = (id: string) => {
    setActiveProject(id);
    setSearchQuery("");
    setSearching(false);
    onClose();
  };

  const groups = focusGroups();
  const agents = agentProjects();
  const pinned = pinnedProjects();
  const focusGroup = focusGroupProjects();
  const isSearching = searching || searchQuery.length > 0;
  const searchResults = filteredProjects();

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      <div className="fixed top-0 left-0 bottom-0 w-[300px] bg-[var(--background)] border-r border-[var(--border)] z-50 flex flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        {/* Header */}
        <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
          <span className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
            Workspaces
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setSearching(!searching); setSearchQuery(""); }}
              className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] text-[13px] hover:text-[var(--text)] transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search bar */}
        {isSearching && (
          <div className="px-4 pb-2 shrink-0">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search workspaces..."
              autoFocus
              className="w-full bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-[var(--text)] text-[11px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
            />
          </div>
        )}

        {/* Focus group tabs */}
        {!isSearching && groups.length > 0 && (
          <div className="px-2 pb-2 flex gap-1 overflow-x-auto shrink-0">
            <FocusGroupTab
              label="All"
              color={null}
              isActive={activeFocusGroupId === null}
              onSelect={() => setActiveFocusGroup(null)}
            />
            {groups.map((g) => (
              <FocusGroupTab
                key={g.id}
                label={g.name}
                color={g.color}
                isActive={activeFocusGroupId === g.id}
                onSelect={() => setActiveFocusGroup(g.id)}
              />
            ))}
          </div>
        )}

        {/* Project list */}
        <div className="flex-1 overflow-y-auto px-2">
          {isSearching ? (
            /* Search results — flat list */
            searchResults.length === 0 ? (
              <p className="text-[var(--text-muted)] text-[11px] text-center py-8">No matching workspaces</p>
            ) : (
              searchResults.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  isActive={p.id === activeProjectId}
                  summary={summaryFor(p.id)}
                  onSelect={() => handleSelect(p.id)}
                />
              ))
            )
          ) : (
            <>
              {/* Zone 1: Agents & Pinned */}
              {(agents.length > 0 || pinned.length > 0) && (
                <div className="pb-2 mb-2 border-b border-[var(--border)]">
                  {agents.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      isActive={p.id === activeProjectId}
                      summary={summaryFor(p.id)}
                      onSelect={() => handleSelect(p.id)}
                      badge="AGENT"
                    />
                  ))}
                  {pinned.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      isActive={p.id === activeProjectId}
                      summary={summaryFor(p.id)}
                      onSelect={() => handleSelect(p.id)}
                      badge="PIN"
                    />
                  ))}
                </div>
              )}

              {/* Zone 2: Focus group workspaces */}
              {focusGroup.length > 0 ? (
                focusGroup.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    isActive={p.id === activeProjectId}
                    summary={summaryFor(p.id)}
                    onSelect={() => handleSelect(p.id)}
                  />
                ))
              ) : (
                <p className="text-[var(--text-muted)] text-[11px] text-center py-8">
                  {activeFocusGroupId ? "No workspaces in this group" : "No workspaces"}
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)] shrink-0">
          {error ? (
            <span className="text-[var(--error)] text-[10px] break-all">{error}</span>
          ) : isLoading ? (
            <span className="text-[var(--text-muted)] text-[10px]">Loading...</span>
          ) : (
            <span className="text-[var(--text-muted)] text-[10px]">
              {projects.length} workspace{projects.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function FocusGroupTab({ label, color, isActive, onSelect }: {
  label: string; color: string | null; isActive: boolean; onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`shrink-0 px-2.5 py-1 text-[10px] font-medium transition-all duration-150 border ${
        isActive
          ? "border-[var(--accent-dim)] text-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)]"
      }`}
    >
      <span className="flex items-center gap-1.5">
        {color && (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        )}
        {label}
      </span>
    </button>
  );
}

function ProjectRow({ project, isActive, summary, onSelect, badge }: {
  project: Project;
  isActive: boolean;
  summary?: { agentsRunning: number; reviewsPending: number };
  onSelect: () => void;
  badge?: "AGENT" | "PIN";
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 transition-all duration-150 ${
        isActive
          ? "bg-white/[0.08] text-[var(--text)]"
          : "text-[var(--text-secondary)] hover:bg-white/[0.04]"
      }`}
    >
      {/* Color icon */}
      {project.iconUrl ? (
        <img src={project.iconUrl} alt="" className="w-5 h-5 shrink-0" />
      ) : (
        <span
          className="w-5 h-5 shrink-0 flex items-center justify-center text-[9px] font-bold text-black"
          style={{ background: project.color }}
        >
          {project.name.charAt(0).toUpperCase()}
        </span>
      )}

      {/* Name + focus group */}
      <div className="flex-1 min-w-0 text-left">
        <span className="text-[12px] font-medium block truncate">{project.name}</span>
        {project.focusGroup && (
          <span className="text-[9px] text-[var(--text-muted)] truncate block">
            {project.focusGroup.name}
          </span>
        )}
      </div>

      {/* Badge */}
      {badge && (
        <span className={`text-[8px] font-bold tracking-wide px-1 py-0.5 shrink-0 ${
          badge === "AGENT"
            ? "text-[var(--accent)] bg-[var(--accent)]/10"
            : "text-[var(--text-muted)] bg-white/5"
        }`}>
          {badge === "AGENT" ? "AGT" : "PIN"}
        </span>
      )}

      {/* Running count */}
      {summary && summary.agentsRunning > 0 && (
        <span className="text-[9px] text-[var(--success)] shrink-0">
          {summary.agentsRunning}
        </span>
      )}

      {/* Review count */}
      {summary && summary.reviewsPending > 0 && (
        <span className="text-[9px] text-[var(--warning)] shrink-0">
          {summary.reviewsPending}
        </span>
      )}
    </button>
  );
}
