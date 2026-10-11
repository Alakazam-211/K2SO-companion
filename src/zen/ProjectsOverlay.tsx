import { useEffect, useMemo, useState } from "react";
import { fetchProjectGroups, type ProjectGroup } from "../api/projectGroups";
import { useServersStore } from "../stores/servers";
import { GroupChatAvatar } from "./GroupChatAvatar";
import { GlassSearchBar, SEARCH_BAR_HEIGHT } from "./GlassSearchBar";
import {
  groupLastAtOf,
  groupPreviewText,
  isGroupUnread,
  isProjectGroupsChangedFrame,
  memberCountText,
  sortGroupsByRecency,
} from "./projectChats";
import { subscribeAppEvents } from "./ticketEvents";
import { mountainListWhen } from "./threadModel";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "./ZenHeaderBlur";
import { useZenStore } from "./zenStore";

// Zen Projects: the Agents header's Projects button opens this sheet of
// project chats (one per project group: a named set of workspaces with
// one shared chat and a PoC agent). Same chrome as Tickets: full-screen
// glass, floating blur header, Done top-left, `.k2-tile` rows.
//
// A row opens the group's chat in the Zen thread view (`openGroupChat`,
// `threadGroupId`). The sheet stays open underneath (zenStore
// `projectsOpen`), so the chat's Back lands here and Done here goes back
// to Agents.
//
// Data: `GET /cli/project-group/list` (name, colour, member count) on
// open; each group's newest message (`messages?limit=1`) for line two,
// the time and the order. Live: `project_groups_changed` on the shared
// `/cli/sessions/events` socket re-reads both.

/** Resting floating-header height below the safe area (title row). */
export const PROJECTS_HEADER_PX = 64;

const AVATAR_PX = 44;

export function ProjectsOverlay({ onClose }: { onClose: () => void }) {
  const serverId = useServersStore((s) => s.activeServerId);
  const agents = useZenStore((s) => s.agents);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const previews = useZenStore((s) => s.groupPreviews);
  useZenStore((s) => s.groupSeenRev); // re-read unread dots after a visit
  const zenScreen = useZenStore((s) => s.screen);
  const [listed, setListed] = useState<ProjectGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [headerRef, headerPx] = useMeasuredHeight(PROJECTS_HEADER_PX);

  // Until the list lands, the Agents read's group rows stand in.
  const fallback = useMemo<ProjectGroup[]>(
    () =>
      agents
        .filter((a) => a.kind === "group" && a.groupId)
        .map((a) => ({
          id: a.groupId as string,
          name: a.name,
          pocWorkspaceId: null,
          pinned: false,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
          memberCount: a.memberCount ?? 0,
        })),
    [agents]
  );
  const groups = listed ?? fallback;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await fetchProjectGroups();
      if (!alive) return;
      if (!r.ok) {
        setError(r.error || "Could not load projects");
        return;
      }
      const rows = (r.data ?? []).filter((g) => g?.id && g.name);
      setError(null);
      setListed(rows);
      void useZenStore.getState().refreshGroupPreviews(rows.map((g) => g.id));
    };
    setListed(null);
    void load();
    const live = subscribeAppEvents(isProjectGroupsChangedFrame, () => void load());
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      live.stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [serverId]);

  // Back from a project chat: re-read line two (the chat may have moved on).
  useEffect(() => {
    if (zenScreen !== "list" || !listed?.length) return;
    void useZenStore.getState().refreshGroupPreviews(listed.map((g) => g.id));
    // Only on the screen change: a new `listed` already re-read them.
  }, [zenScreen]);

  const query = q.trim().toLowerCase();
  const visible = sortGroupsByRecency(
    query ? groups.filter((g) => g.name.toLowerCase().includes(query)) : groups,
    lastAtByKey
  );

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-projects"
    >
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="projects-header"
        style={{ zIndex: 3, paddingTop: "env(safe-area-inset-top)", pointerEvents: "none" }}
      >
        <ZenHeaderBlur testId="projects-header-blur" />
        <div ref={headerRef} className="relative w-full min-w-0">
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: "1fr auto 1fr",
              minHeight: 44,
              padding: "12px 12px 8px",
              columnGap: 8,
            }}
          >
            <button
              type="button"
              className="text-[17px] justify-self-start zen-glass zen-glass-pill"
              style={{ minHeight: 34, padding: "0 14px", color: "#fff", pointerEvents: "auto" }}
              onClick={onClose}
              data-testid="projects-done"
            >
              Done
            </button>
            <h1 className="text-[17px] font-semibold pointer-events-none zen-header-text">
              Projects
            </h1>
            <span />
          </div>
        </div>
      </header>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingTop: underHeaderPadding(headerPx),
          paddingLeft: 12,
          paddingRight: 12,
          // Clear the floating search bar.
          paddingBottom: `calc(${SEARCH_BAR_HEIGHT + 28}px + env(safe-area-inset-bottom))`,
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="projects-scroller"
      >
        {error ? (
          <p className="py-4 text-[14px]" style={{ color: "#f59e0b" }}>
            {error}
          </p>
        ) : null}
        {listed === null && groups.length === 0 && !error ? (
          <p className="py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            Loading projects…
          </p>
        ) : null}
        {listed !== null && visible.length === 0 ? (
          <p
            className="py-10 text-center text-[15px]"
            style={{ color: "#8e8e93" }}
            data-testid="projects-empty"
          >
            {query ? "No matching project chats" : "No project chats yet"}
          </p>
        ) : null}
        <div className="flex flex-col gap-2.5 pt-3">
          {visible.map((g) => {
            const lastAt = groupLastAtOf(lastAtByKey, g.id);
            const preview = groupPreviewText(previews[g.id]);
            const unread = isGroupUnread(serverId, g.id, lastAt);
            return (
              <button
                key={g.id}
                type="button"
                className="w-full min-w-0 text-left k2-tile flex items-center"
                style={{ padding: "10px 12px", borderRadius: 14, gap: 12 }}
                onClick={() => useZenStore.getState().openGroupChat(g)}
                data-testid="project-row"
                data-group-id={g.id}
                aria-label={`${g.name}, ${memberCountText(g.memberCount)}${unread ? ", unread" : ""}`}
              >
                <GroupChatAvatar groupId={g.id} name={g.name} color={g.color} size={AVATAR_PX} fontSize={18} />
                <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
                  <span className="w-full min-w-0 flex items-center" style={{ gap: 8 }}>
                    <span className="flex-1 min-w-0 text-[16px] font-semibold truncate">
                      {g.name}
                    </span>
                    {lastAt != null ? (
                      <span
                        className="shrink-0 text-[13px] tabular-nums"
                        style={{ color: "#8e8e93" }}
                        data-testid="project-when"
                      >
                        {mountainListWhen(lastAt)}
                      </span>
                    ) : null}
                  </span>
                  <span className="w-full min-w-0 flex items-center" style={{ gap: 8 }}>
                    <span
                      className="flex-1 min-w-0 text-[14px] truncate"
                      style={{ color: "#a1a1aa" }}
                      data-testid="project-preview"
                    >
                      {preview || memberCountText(g.memberCount)}
                    </span>
                    {unread ? (
                      <span
                        aria-hidden
                        className="shrink-0"
                        data-testid="project-unread"
                        style={{ width: 9, height: 9, borderRadius: "50%", background: "#0a84ff" }}
                      />
                    ) : null}
                  </span>
                  {preview ? (
                    <span className="text-[12px]" style={{ color: "#8e8e93" }}>
                      {memberCountText(g.memberCount)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <GlassSearchBar
        query={q}
        onQuery={setQ}
        placeholder="Search projects"
        searchLabel="Search projects"
        testId="projects-search"
        inputTestId="projects-search-input"
      />
    </div>
  );
}
