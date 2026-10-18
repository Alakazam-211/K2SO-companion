import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProjectGroups, type ProjectGroup } from "../api/projectGroups";
import { useZenScope } from "./zenScope";
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
import { useBackHandler } from "../lib/androidBack";
import { rowUnreadFor, toneColor } from "./unread";
import { unreadSupported, useUnreadStore } from "./unreadStore";
import { MutedGlyph, MuteMenuItems, RowUnreadCount } from "./UnreadMarks";

/** A still press this long opens a project row's menu (Mute). */
const PROJECT_HOLD_MS = 500;

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
  // Zen's server (the list's: the active one). Project chats live there.
  const zen = useZenScope();
  const serverId = zen.id || null;
  const agents = useZenStore((s) => s.agents);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const previews = useZenStore((s) => s.groupPreviews);
  useZenStore((s) => s.groupSeenRev); // re-read unread dots after a visit
  const zenScreen = useZenStore((s) => s.screen);
  const [listed, setListed] = useState<ProjectGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [headerRef, headerPx] = useMeasuredHeight(PROJECTS_HEADER_PX);
  // Unread (K2 0.46.1 `thread-read-v1`): the server's counts and Mute; an
  // older server keeps this device's last-seen dot.
  const unreadServers = useUnreadStore((s) => s.servers);
  const unreadAddrs = useUnreadStore((s) => s.addrs);
  const unreadOn = !!serverId && !!unreadServers[serverId] && unreadSupported(serverId);
  const [menu, setMenu] = useState<{ groupId: string; top: number } | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const skipClick = useRef(false);
  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => clearHold, []);
  useBackHandler(menu !== null, () => setMenu(null));
  // Android Back = Done. A project chat opened from here registers on
  // top, so its Back lands back on this sheet first.
  useBackHandler(true, onClose);

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
      const r = await fetchProjectGroups(zen);
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
    const live = subscribeAppEvents(zen, isProjectGroupsChangedFrame, () => void load());
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      live.stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [zen]);

  // Back from a project chat: re-read line two (the chat may have moved on).
  useEffect(() => {
    if (zenScreen !== "list" || !listed?.length) return;
    void useZenStore.getState().refreshGroupPreviews(listed.map((g) => g.id));
    // Only on the screen change: a new `listed` already re-read them.
  }, [zenScreen]);

  const query = q.trim().toLowerCase();
  const visible = sortGroupsByRecency(
    query ? groups.filter((g) => g.name.toLowerCase().includes(query)) : groups,
    lastAtByKey,
    serverId
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
          paddingBottom: `calc(${SEARCH_BAR_HEIGHT + 28}px + var(--safe-bottom))`,
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
            const lastAt = groupLastAtOf(lastAtByKey, serverId, g.id);
            const preview = groupPreviewText(previews[g.id]);
            const marks = unreadOn
              ? rowUnreadFor(unreadServers, unreadAddrs, serverId, { kind: "group", groupId: g.id })
              : null;
            const unread = unreadOn
              ? !!marks && (marks.tone !== "muted" || marks.count > 0)
              : isGroupUnread(serverId, g.id, lastAt);
            const strong = !!marks?.emphasis;
            return (
              <button
                key={g.id}
                type="button"
                className="w-full min-w-0 text-left k2-tile flex items-center"
                style={{ padding: "10px 12px", borderRadius: 14, gap: 12, WebkitTouchCallout: "none" }}
                onClick={() => {
                  if (skipClick.current) {
                    skipClick.current = false;
                    return;
                  }
                  useZenStore.getState().openGroupChat(g);
                }}
                onPointerDown={(e) => {
                  skipClick.current = false;
                  clearHold();
                  if (!unreadOn) return;
                  const el = e.currentTarget;
                  hold.current = {
                    x: e.clientX,
                    y: e.clientY,
                    timer: setTimeout(() => {
                      hold.current = null;
                      skipClick.current = true;
                      setMenu({ groupId: g.id, top: el.getBoundingClientRect().bottom + 4 });
                    }, PROJECT_HOLD_MS),
                  };
                }}
                onPointerMove={(e) => {
                  const h = hold.current;
                  if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) clearHold();
                }}
                onPointerUp={clearHold}
                onPointerCancel={clearHold}
                onContextMenu={(e) => {
                  if (!unreadOn) return;
                  e.preventDefault();
                  clearHold();
                  setMenu({ groupId: g.id, top: e.currentTarget.getBoundingClientRect().bottom + 4 });
                }}
                data-testid="project-row"
                data-group-id={g.id}
                aria-label={`${g.name}, ${memberCountText(g.memberCount)}${
                  marks?.tone === "waiting" ? ", waiting on you" : unread ? ", unread" : ""
                }${marks?.muted ? ", muted" : ""}`}
              >
                <GroupChatAvatar groupId={g.id} name={g.name} color={g.color} size={AVATAR_PX} fontSize={18} />
                <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
                  <span className="w-full min-w-0 flex items-center" style={{ gap: 8 }}>
                    <span
                      className="flex-1 min-w-0 text-[16px] font-semibold truncate"
                      style={strong ? { fontWeight: 700 } : undefined}
                    >
                      {g.name}
                    </span>
                    {marks?.muted ? <MutedGlyph /> : null}
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
                      style={strong ? { color: "#f2f2f7", fontWeight: 600 } : { color: "#a1a1aa" }}
                      data-testid="project-preview"
                    >
                      {preview || memberCountText(g.memberCount)}
                    </span>
                    {marks && marks.count > 1 ? (
                      <RowUnreadCount unread={marks} />
                    ) : unread ? (
                      <span
                        aria-hidden
                        className="shrink-0"
                        data-testid="project-unread"
                        data-tone={marks?.tone}
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: marks ? toneColor(marks.tone) : "#0a84ff",
                        }}
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
      {menu ? (
        <div>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 bg-transparent border-0 p-0"
            style={{ zIndex: 29 }}
            onClick={() => setMenu(null)}
            data-testid="project-menu-backdrop"
          />
          <div
            role="menu"
            className="zen-glass fixed"
            data-testid="project-row-menu"
            style={{
              zIndex: 30,
              top: `min(${menu.top}px, calc(100vh - 220px))`,
              right: 16,
              width: 230,
              borderRadius: 16,
              padding: 6,
              color: "#fff",
            }}
          >
            <MuteMenuItems
              serverId={serverId}
              rowRef={{ kind: "project", groupId: menu.groupId }}
              onDone={() => setMenu(null)}
            />
          </div>
        </div>
      ) : null}
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
