// Slice C2 — the mobile Projects tab (PRD §2): the ACTIVE server's
// project groups. Nested router: the list at /projects, the PoC chat at
// /projects/:groupId, the HTML-dashboards browser at
// /projects/:groupId/docs. Only the LIST renders inside the normal app
// chrome (ServerFooter + TabBar stay visible); the chat/docs screens are
// full-screen overlays — the /chat/:id "hide all nav chrome" behavior
// without touching the shared TabBar/ServerFooter components (slice C3
// edits those for its badge).

import { useEffect, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { useServersStore } from "../stores/servers";
import { useProjectGroupsStore, startEvents } from "../stores/projectGroups";
import { GroupAvatar } from "../components/GroupAvatar";
import { ProjectChat } from "./ProjectChat";
import { ProjectHtmlDocs } from "./ProjectHtmlDocs";
import type { ProjectGroup } from "../api/projectGroups";
import { partitionPinnedAlpha } from "../api/projectGroupsPure";

export function ProjectsPage() {
  return (
    <Routes>
      <Route index element={<ProjectsList />} />
      <Route path=":groupId" element={<ProjectChat />} />
      <Route path=":groupId/docs" element={<ProjectHtmlDocs />} />
    </Routes>
  );
}

function memberLine(group: ProjectGroup, pocName: string | undefined): string {
  const members = `${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`;
  if (pocName) return `${members} · PoC ${pocName}`;
  if (!group.pocWorkspaceId) return `${members} · no PoC yet`;
  return members;
}

function ProjectsList() {
  const navigate = useNavigate();
  const activeServerId = useServersStore((s) => s.activeServerId);
  const groups = useProjectGroupsStore((s) => s.groups);
  const loading = useProjectGroupsStore((s) => s.loading);
  const error = useProjectGroupsStore((s) => s.error);
  const pocNames = useProjectGroupsStore((s) => s.pocNames);
  const unreadGroupIds = useProjectGroupsStore((s) => s.unreadGroupIds);
  const [refreshing, setRefreshing] = useState(false);

  // (Re)load + (re)subscribe whenever the ACTIVE server changes — every
  // fetch and the events socket derive base URL + token from it. The
  // store remembers which server its groups belong to (`forServerId`),
  // so a switch that happened while this page was unmounted still
  // resets instead of rendering another server's groups.
  useEffect(() => {
    const store = useProjectGroupsStore.getState();
    if (activeServerId && store.forServerId !== activeServerId) {
      store.resetForServer();
      void useProjectGroupsStore.getState().refreshGroups();
    } else if (activeServerId && store.groups === null) {
      void store.refreshGroups();
    }
    return startEvents();
  }, [activeServerId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await useProjectGroupsStore.getState().refreshGroups();
    setRefreshing(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header — the AppHeader idiom, page-local (AppHeader is
          session-list chrome only). */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <span className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
          Projects
        </span>
        <span className="text-[var(--text-muted)] text-[11px]">
          {groups?.length ?? 0} {(groups?.length ?? 0) === 1 ? "project" : "projects"}
        </span>
        <button
          onClick={handleRefresh}
          className="w-8 h-8 flex items-center justify-center text-[var(--text-muted)]"
          style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
        </button>
      </div>

      {/* Group list */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {error ? (
          <div className="flex flex-col items-center justify-center h-full px-8 gap-3">
            <span className="text-[var(--error)] text-[12px] text-center">{error}</span>
            <button
              onClick={handleRefresh}
              className="px-4 py-2 border border-[var(--accent-dim)] text-[var(--accent)] text-[12px]"
            >
              Retry
            </button>
          </div>
        ) : groups === null || (loading && groups.length === 0) ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-[var(--text-muted)] text-[12px]">Loading projects…</span>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8 gap-2">
            <span className="text-[var(--text-muted)] text-[13px]">No projects yet</span>
            <span className="text-[var(--text-muted)] text-[11px] opacity-60 text-center leading-5">
              Create a project on the desktop to chat with its Point of Contact here.
            </span>
          </div>
        ) : (
          (() => {
            // Mobile order: pinned block first (daemon's relative order),
            // then everything else A–Z — sort_order deliberately ignored
            // for the unpinned tail (product call).
            const { pinned, rest } = partitionPinnedAlpha(groups);
            const renderGroup = (g: ProjectGroup) => (
              <button
                key={g.id}
                onClick={() => navigate(`/projects/${g.id}`)}
                className="flex items-center gap-3 px-4 py-4 min-h-[60px] bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-colors text-left w-full"
              >
                <GroupAvatar groupId={g.id} name={g.name} color={g.color} />
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text)] text-[13px] font-semibold truncate">
                    {g.name}
                  </div>
                  <div className="text-[var(--text-muted)] text-[11px] truncate mt-0.5">
                    {memberLine(g, pocNames[g.id])}
                  </div>
                </div>
                {unreadGroupIds.has(g.id) && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: "var(--accent)" }}
                  />
                )}
              </button>
            );
            return (
              <div className="py-2 px-1.5 flex flex-col gap-2">
                {pinned.length > 0 && (
                  <div className="px-2.5 pt-1 text-[var(--text-muted)] text-[10px] uppercase tracking-wide">
                    Pinned
                  </div>
                )}
                {pinned.map(renderGroup)}
                {rest.map(renderGroup)}
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
