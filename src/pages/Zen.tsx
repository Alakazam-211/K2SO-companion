import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { fullViewportHeight, useViewport, useViewportTrackRef } from "../lib/useViewportHeight";
import { WorkspaceAvatar } from "../zen/WorkspaceAvatar";
import { GroupChatAvatar } from "../zen/GroupChatAvatar";
import { useWorkspacesStore } from "../stores/workspaces";
import { getAllSessions, type GlobalSession } from "../api/client";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { useFileDrag } from "../zen/fileDrag";
import { SessionsPane } from "../zen/SessionsPane";
import { useSwipeBack } from "../lib/useSwipeBack";
import { useBackHandler } from "../lib/androidBack";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import {
  ZEN_ADDR_PARAM,
  ZEN_PROJECT_PARAM,
  readZenReturnState,
  rememberZenReturn,
  rememberZenThread,
  terminalIdForAgent,
  zenTerminalPath,
  zenTerminalReturn,
  type ZenTerminalAgent,
} from "../zen/terminalJump";
import { resumeSessionThread } from "../zen/sessionReturn";
import { ThreadPane } from "../zen/ThreadPane";
import { ZEN_SEQ_PARAM, zenFocusSeq } from "../zen/threadFocus";
import { STUB_BANNER } from "../zen/stubData";
import {
  isOverlayExtraAddr,
  threadHeaderTitle,
  threadSessionHeaderTitle,
  threadSidecarTitle,
} from "../zen/overlayExtras";
import { groupRowId, useZenStore } from "../zen/zenStore";
import { AgentIconSheet } from "../zen/AgentIconSheet";
import { canChangeIcon, iconTargetFor } from "../zen/workspaceIcon";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { roomServerId, useZenScope } from "../zen/zenScope";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { noteRoomInput, useRoomLife } from "../zen/room/useRoomLife";
import { RoomBanner } from "../zen/room/RoomBanner";
import { ServerChip } from "../zen/room/ServerChip";
import { ZEN_SERVER_PARAM, resolveServerRef, withServerParam } from "../zen/room/serverRef";
import { OverlayAddServer } from "../zen/OverlayAddServer";
import { pool } from "../zen/multi/pool";
import { FileIcon, TerminalIcon } from "../zen/icons";
import { LlmIcon } from "../zen/LlmIcon";
import { harnessKey, recallHarness, rememberHarness } from "../zen/harnessMemory";
import { useThreadHarness } from "../zen/threadHarness";
import { harnessForRow } from "../zen/agentActivity";
import { normalizeHarness } from "../zen/llmHarness";
import { readListTab } from "../zen/homes";
import { BackUnreadPill, useBackUnreadCount } from "../zen/UnreadMarks";
import { useUnreadSync } from "../zen/unreadSync";
import { useUnreadPrefetch } from "../zen/chatPrefetch";

const HEADER_BTN: CSSProperties = {
  width: 36,
  height: 36,
  color: "#fff",
};

/** iMessage contact photo above the name. */
const HEADER_AVATAR_PX = 42;
/** Resting header content height (below the safe area): avatar + name. */
export const CHAT_HEADER_PX = 84;
/** Soft shadow under the header avatar, over the name bubble. */
const AVATAR_LIFT = "drop-shadow(0 3px 8px rgba(0, 0, 0, 0.55))";
/** Buttons centre on the avatar. */
const HEADER_BTN_TOP = (HEADER_AVATAR_PX - 36) / 2;

export function Zen() {
  const navigate = useNavigate();
  // offsetTop: an iOS pan the scroll reset could not undo (resume with
  // the composer focused, IMG_0844) — the fixed home follows it down.
  // motion: the iOS keyboard is easing the height (UIKeyboardWill*): the
  // column glides on its curve and the Thread pins the newest throughout.
  const {
    height: containerHeight,
    offsetTop: viewportTop,
    motion: viewportMotion,
    interactive: viewportInteractive,
  } = useViewport();
  // Interactive keyboard dismiss: the store sizes the column per frame.
  const threadColumnRef = useViewportTrackRef();
  const [params, setParams] = useSearchParams();
  const threadParam = params.get("thread");
  // Push tap on a project chat: `/zen?project=<groupId>`.
  const projectParam = (params.get(ZEN_PROJECT_PARAM) || "").trim();
  // Terminal Done: `/zen?addr=<session addr>` (+ state.zenReturn).
  const addrParam = (params.get(ZEN_ADDR_PARAM) || "").trim();
  // Push tap: `/zen?addr=<addr>&seq=<seq>` also scrolls to that message.
  const seqParam = addrParam ? zenFocusSeq(params.get(ZEN_SEQ_PARAM)) : null;
  const location = useLocation();
  // Multi-server rooms (MA17): `?server=` names the thread's server. Only
  // with the flag on; without it (or with the flag off) the active server.
  const multiOn = useMultiServerPrefs((s) => s.multiServer);
  const serverRef = multiOn ? (params.get(ZEN_SERVER_PARAM) || "").trim() : "";
  const paramServer = serverRef ? resolveServerRef(serverRef) : null;
  /** A `server=` that names no saved server: drop the link, never open it
   *  on another server (MS7). */
  const deadServerLink = Boolean(serverRef) && !paramServer;
  const screen = useZenStore((s) => s.screen);
  const agentId = useZenStore((s) => s.agentId);
  const agents = useZenStore((s) => s.agents);
  const agentSource = useZenStore((s) => s.agentSource);
  const fileSource = useZenStore((s) => s.fileSource);
  const agentError = useZenStore((s) => s.agentError);
  const fileError = useZenStore((s) => s.fileError);
  const hydrateAgents = useZenStore((s) => s.hydrateAgents);
  const closeChat = useZenStore((s) => s.closeChat);
  const dismissFiles = useZenStore((s) => s.dismissFiles);
  const toggleFiles = useZenStore((s) => s.toggleFiles);
  const filesOpen = useZenStore((s) => s.filesOpen);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const drawerOrigin = useZenStore((s) => s.drawerOrigin);
  const returnToDrawerOrigin = useZenStore((s) => s.returnToDrawerOrigin);
  const agent = agents.find((a) => a.id === agentId);
  /** A project chat (project group): only Files (the group's resources),
   *  no Terminal or Sessions. */
  const groupChat = agent?.kind === "group" && Boolean(agent.groupId);
  const projectsOpen = useZenStore((s) => s.projectsOpen);
  /** Opened from the Projects sheet: Back (and the edge swipe) return there. */
  const fromProjects = groupChat && projectsOpen;
  /** Opened from the Sessions drawer: Done (not Back) returns to the origin. */
  const drawerPicked = Boolean(drawerOrigin) && drawerOrigin !== agentId;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const extraChat = isOverlayExtraAddr(agent?.addr);
  const headerTitle = threadHeaderTitle(agent);
  const sidecarTitle = threadSidecarTitle(agent);
  /** Centre title: `<Agent>`, or `<Agent>/<sidecar>` on a separate session. */
  const centreTitle =
    extraChat || drawerPicked ? threadSessionHeaderTitle(agent, drawerPicked) : headerTitle;
  /** The chat's LLM, left of the header avatar (none for a project chat
   *  or when nothing tells). Live: the snapshot, else the row's launch
   *  command; else the last one seen for this chat (below). */
  const liveHarness = useZenStore((s) =>
    !agent || groupChat
      ? null
      : normalizeHarness(harnessForRow(agent, s.activity, extraChat, s.chatSessions)) ??
        normalizeHarness(agent.launch?.command)
  );
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerPx, setHeaderPx] = useState(CHAT_HEADER_PX);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const serverProjects = useZenStore((s) => s.serverProjects);
  const zen = useZenScope();
  const harnessAt = !agent || groupChat ? "" : harnessKey(zen.id, agent);
  useEffect(() => {
    if (liveHarness) rememberHarness(harnessAt, liveHarness);
  }, [harnessAt, liveHarness]);
  // Unread counts (K2 0.46.1 `thread-read-v1`): summaries, frames, badge.
  useUnreadSync();
  // A chat whose unread state moves is prefetched (fresh when opened).
  useUnreadPrefetch();
  const openAddr = useZenStore((s) => s.threadAddr);
  const openConv = useZenStore((s) => s.threadConversationId);
  // The Thread's own session first (its conversation's provider), then
  // the live snapshot / launch command, then the last one seen here.
  const threadHarness = useThreadHarness(
    !agent || groupChat ? null : zen,
    agent?.path,
    openConv
  );
  const headerHarness =
    threadHarness ?? liveHarness ?? (harnessAt ? recallHarness(harnessAt) : null);
  const openGroup = useZenStore((s) => (s.threadGroupId || "").trim());
  // Back's count: the list it returns to, the open chat left out. The
  // Agents / Home pick cannot change while a chat is open.
  const backUnread = useBackUnreadCount({
    origin: fromProjects ? "projects" : readListTab() === "home" ? "home" : "agents",
    serverId: zen.id,
    open: openGroup
      ? { kind: "project", groupId: openGroup }
      : openAddr || openConv
        ? { kind: "thread", addr: openAddr, conversationId: openConv }
        : null,
    multiOn,
  });
  const identity = useSessionIdentity(zen);
  const [iconOpen, setIconOpen] = useState(false);
  // Header avatar → Change icon: the workspace's (a sidecar edits its parent's).
  const iconTarget = canChangeIcon(identity) ? iconTargetFor(agent, serverProjects) : null;
  const viewingFile = openFileIds.length > 0;
  /** A file is being dragged out of the Files drawer: the drawer slides
   *  mostly aside and fades so the composer under it is a drop target. */
  const fileDragging = useFileDrag((s) => s.drag !== null);
  const filesPaneOpen = filesOpen || viewingFile;

  // A different chat closes the Sessions drawer (and the icon sheet).
  useEffect(() => {
    setSessionsOpen(false);
    setIconOpen(false);
  }, [agentId]);

  const openTerminal = (tid: string, chatTitle: string | null) => {
    // Done on the terminal returns to this exact Thread (Done mode, origin),
    // on this room's server (MA17).
    const roomServer = roomServerId();
    const back = zenTerminalReturn(agent, tid, drawerOrigin, roomServer);
    rememberZenReturn(back);
    const ctx: ZenTerminalAgent | null = agentId
      ? {
          agentId,
          name: headerTitle,
          initial: agent?.initial ?? null,
          color: agent?.color ?? null,
          iconUrl: agent?.iconUrl ?? null,
          chatTitle,
          projectPath: agent?.path ?? null,
          addr: agent?.addr ?? null,
          back,
          ...(roomServer ? { serverId: roomServer } : {}),
        }
      : null;
    navigate(withServerParam(zenTerminalPath(tid), roomServer), {
      state: ctx ? { agent: ctx } : undefined,
    });
  };
  // ?thread= paints the thread on first frame (no chats-list flash). After
  // Back, ignore that query until it is stripped, or closeChat leaves an em dash.
  const [ignoreThreadQuery, setIgnoreThreadQuery] = useState(false);
  const skipHydrateOnClear = useRef(false);
  const wantThread =
    screen === "thread" ||
    (Boolean((threadParam || "").trim() || addrParam) && !ignoreThreadQuery && !deadServerLink);
  // The open room's life: keep-alive, foreground resync, failure banner
  // (multi-server MS24/MS28/MS36). Inert with the flag off.
  const room = useRoomLife({ open: wantThread, agent });

  // `?addr=` reopens that session's Thread before paint. The cold
  // hydrate below must not run over it (it ends Done mode).
  const zenReturn = readZenReturnState(location.state, addrParam);
  const zenReturnKey = zenReturn ? JSON.stringify(zenReturn) : "";
  useLayoutEffect(() => {
    if (!addrParam || seqParam == null) return;
    useZenStore.setState({ threadFocusSeq: seqParam });
  }, [addrParam, seqParam]);
  useLayoutEffect(() => {
    if (!addrParam || deadServerLink) return;
    // A session's Thread (push tap, terminal Done): not inside Projects.
    useZenStore.getState().setProjectsOpen(false);
    setIgnoreThreadQuery(false);
    // The link's server (none = the active one), before anything loads.
    useZenStore.getState().enterRoomServer(paramServer);
    void resumeSessionThread(addrParam, zenReturnKey ? JSON.parse(zenReturnKey) : null);
  }, [addrParam, zenReturnKey, paramServer, deadServerLink]);

  // `?project=<groupId>`: open Projects, then that project chat on top
  // (Back lands on the sheet). Rewritten to the `?thread=group:<id>`
  // resume so the group row comes from the same list read.
  // (navigate from an effect: the router ignores one during mount layout.)
  useEffect(() => {
    if (!projectParam) return;
    useZenStore.getState().setProjectsOpen(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ZEN_PROJECT_PARAM);
        next.delete(ZEN_ADDR_PARAM);
        next.delete(ZEN_SEQ_PARAM);
        next.set("thread", groupRowId(projectParam));
        return next;
      },
      { replace: true }
    );
  }, [projectParam, setParams]);

  // Chat return (`?thread=`) must first-paint LOADING, never leftover bubbles.
  // hydrateAgents is useEffect (after paint); this runs before paint.
  useLayoutEffect(() => {
    const id = (threadParam || "").trim();
    if (!id || ignoreThreadQuery || deadServerLink) return;
    useZenStore.getState().enterRoomServer(paramServer);
    useZenStore.setState({
      screen: "thread",
      agentId: id,
      thread: [],
      threadError: null,
      threadSource: "loading",
      sending: false,
      sendError: null,
      threadGroupId: null,
    });
  }, [threadParam, ignoreThreadQuery, paramServer, deadServerLink]);

  useEffect(() => {
    const id = (threadParam || "").trim();
    if (deadServerLink) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of ["thread", ZEN_ADDR_PARAM, ZEN_SEQ_PARAM, ZEN_SERVER_PARAM]) next.delete(k);
          return next;
        },
        { replace: true }
      );
      return;
    }
    if (id) {
      setIgnoreThreadQuery(false);
      void hydrateAgents({ resumeId: id });
      return;
    }
    if (addrParam) return;
    // Rewritten to `?thread=group:<id>` this frame; that resume hydrates.
    if (projectParam) return;
    if (skipHydrateOnClear.current) {
      skipHydrateOnClear.current = false;
      return;
    }
    void hydrateAgents();
  }, [hydrateAgents, threadParam, addrParam, projectParam, deadServerLink, setParams]);

  const backToChats = () => {
    // closeChat is zustand-sync and would re-render with the query still
    // holding the thread column (empty name, em dash). Dismiss first.
    flushSync(() => setIgnoreThreadQuery(true));
    closeChat();
    if ((threadParam || "").trim() || addrParam || serverRef) {
      skipHydrateOnClear.current = true;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("thread");
          next.delete(ZEN_ADDR_PARAM);
          next.delete(ZEN_SEQ_PARAM);
          next.delete(ZEN_SERVER_PARAM);
          return next;
        },
        { replace: true }
      );
    }
  };

  // Android Back on the open chat: the header's Done (drawer-picked) or
  // Back, the same as the edge swipe. Layers over the chat (drawers,
  // sheets, the file viewer) register on their own, later, so they win.
  // The edge swipe asks the same stack: it arms only while the chat is
  // the topmost layer (rename, icon sheet, sign-in, drawers all register).
  const threadOnTop = useBackHandler(wantThread, drawerPicked ? returnToDrawerOrigin : backToChats);
  /** The chats list peeks from under a back-chevron swipe (it is where
   *  Back lands); Done returns to another chat, so that drag shows black. */
  const chatsLayerRef = useRef<HTMLDivElement>(null);
  const peekChats = (on: boolean) => {
    const el = chatsLayerRef.current;
    if (!el) return;
    if (on) el.setAttribute("data-peek", "1");
    else el.removeAttribute("data-peek");
  };

  const closeRename = () => {
    if (renameBusy) return;
    setRenameOpen(false);
    setRenameError(null);
  };
  useBackHandler(wantThread && renameOpen && extraChat, closeRename);

  // The header floats over the list; the list's top padding tracks the
  // header's real height (Hide chat, banner grow it).
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const read = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setHeaderPx(h);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wantThread]);

  const stubBanner =
    agentSource === "stub" && fileSource === "stub" ? STUB_BANNER : "";
  const err = [agentError, fileError].filter(Boolean).join(" · ");
  const headerSub = [stubBanner, err].filter(Boolean).join(" · ");

  return (
    <div className="relative h-full min-h-0 zen-font" style={{ background: "#000" }}>
      <div
        ref={chatsLayerRef}
        className="h-full min-h-0 zen-chats-layer"
        data-testid="chats-layer"
        style={
          wantThread
            ? {
                visibility: "hidden",
                position: "absolute",
                inset: 0,
                // Own stacking context: its sheets (Projects z 6…) stay
                // under the thread when the list peeks during a swipe.
                zIndex: 0,
                pointerEvents: "none",
              }
            : undefined
        }
        aria-hidden={wantThread}
      >
        <ChatsList />
      </div>
      {wantThread ? (
        // The ChatsList keyboard idiom (981b610): a `fixed` backdrop so an
        // iOS keyboard pan of #root cannot drag the header off screen, plus
        // a column sized to visualViewport.height so the composer at its
        // bottom sits directly above the keyboard.
        <ThreadHome
          onSwipeBack={drawerPicked ? returnToDrawerOrigin : backToChats}
          swipeEnabled={() => !filesPaneOpen && !sessionsOpen && threadOnTop()}
          onSwipeDrag={drawerPicked ? undefined : peekChats}
          top={viewportTop}
        >
        <div
          className="relative flex flex-col min-h-0 overflow-x-hidden"
          data-testid="thread-column"
          ref={threadColumnRef}
          // Keyboard motion plays on the compositor (ThreadPane's FLIP): no
          // height transition. While the keyboard rises the column stays
          // at its old height (nothing clipped) and takes the new one as
          // the motion clears. During an interactive dismiss it is full
          // height (as beginKeyboardDrag set it).
          style={{
            height: viewportInteractive
              ? fullViewportHeight()
              : viewportMotion && viewportMotion.to < viewportMotion.from
                ? viewportMotion.from
                : containerHeight,
          }}
          onClick={
            filesPaneOpen || sessionsOpen
              ? () => {
                  if (filesPaneOpen) dismissFiles();
                  setSessionsOpen(false);
                }
              : undefined
          }
        >
          {/* Floats over the list from y=0 (under the status bar). The blur
              and the header box pass touches through; only its controls
              take them, so the list still scrolls underneath. */}
          <header
            className="absolute top-0 left-0 right-0 w-full min-w-0"
            data-testid="chat-header"
            style={{
              zIndex: 10,
              paddingTop: "env(safe-area-inset-top)",
              pointerEvents: "none",
            }}
          >
            <div className="zen-header-blur" data-testid="chat-header-blur" aria-hidden>
              <span className="zen-header-blur-1" />
              <span className="zen-header-blur-2" />
              <span className="zen-header-blur-3" />
              <span className="zen-header-blur-4" />
              <span className="zen-header-tint" />
            </div>
            <div
              ref={headerRef}
              className="relative grid items-start w-full min-w-0 px-3"
              data-testid="chat-header-content"
              style={{
                gridTemplateColumns: "1fr auto 1fr",
                minHeight: CHAT_HEADER_PX,
                paddingTop: 6,
                paddingBottom: 12,
                columnGap: 8,
              }}
            >
            {drawerPicked ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                returnToDrawerOrigin();
              }}
              data-testid="chat-done"
              className="text-[17px] shrink-0 justify-self-start zen-glass zen-glass-pill"
              style={{
                minHeight: 36,
                padding: "0 14px",
                color: "#fff",
                marginTop: HEADER_BTN_TOP,
                pointerEvents: "auto",
              }}
            >
              Done
            </button>
            ) : (
            <button
              type="button"
              onClick={backToChats}
              data-testid="chat-back"
              className="flex items-center justify-center shrink-0 justify-self-start zen-glass zen-glass-pill"
              style={{
                ...HEADER_BTN,
                ...(backUnread > 0 ? { width: "auto", minWidth: 36, padding: "0 8px 0 6px", gap: 2 } : null),
                marginTop: HEADER_BTN_TOP,
                pointerEvents: "auto",
              }}
              aria-label={
                (fromProjects ? "Back to projects" : "Back to chats") +
                (backUnread > 0 ? `, ${backUnread > 99 ? "99+" : backUnread} unread` : "")
              }
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <BackUnreadPill count={backUnread} />
            </button>
            )}
            <div className="min-w-0 flex flex-col items-center justify-center zen-header-text">
              {/* The avatar overlaps the name bubble's top edge; the shadow
                  lifts it off the glass. */}
              <span className="relative flex" style={{ zIndex: 2 }}>
              {headerHarness ? (
                <span
                  data-testid="chat-header-llm"
                  data-llm={headerHarness}
                  className="absolute flex items-center"
                  style={{ right: "100%", marginRight: 8, top: 0, height: HEADER_AVATAR_PX }}
                >
                  <LlmIcon harness={headerHarness} size={18} />
                </span>
              ) : null}
              {iconTarget ? (
                <button
                  type="button"
                  data-testid="chat-header-avatar"
                  className="flex bg-transparent border-0 p-0"
                  style={{ borderRadius: "50%", pointerEvents: "auto", filter: AVATAR_LIFT }}
                  aria-label={`Change icon for ${headerTitle}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (filesPaneOpen) dismissFiles();
                    setSessionsOpen(false);
                    setIconOpen(true);
                  }}
                >
                  <WorkspaceAvatar
                    initial={agent?.initial || headerTitle.slice(0, 1) || "?"}
                    color={agent?.color}
                    iconUrl={agent?.iconUrl}
                    size={HEADER_AVATAR_PX}
                    fontSize={16}
                    fallback="#2c2c2e"
                  />
                </button>
              ) : (
                <span data-testid="chat-header-avatar" className="flex" style={{ filter: AVATAR_LIFT }}>
                  {groupChat && agent?.groupId ? (
                    // The project's own image from its settings, else its
                    // colour + initial (the Projects sheet row's avatar).
                    <GroupChatAvatar
                      groupId={agent.groupId}
                      name={agent.name || headerTitle}
                      color={agent.color}
                      size={HEADER_AVATAR_PX}
                      fontSize={16}
                    />
                  ) : (
                    <WorkspaceAvatar
                      initial={agent?.initial || headerTitle.slice(0, 1) || "?"}
                      color={agent?.color}
                      iconUrl={agent?.iconUrl}
                      size={HEADER_AVATAR_PX}
                      fontSize={16}
                      fallback="#2c2c2e"
                    />
                  )}
                </span>
              )}
              </span>
              {/* Main chat: `<Agent>`. A separate session swaps in
                  `<Agent>/<sidecar>` plus the rename pencil; the text
                  truncates, the pencil never does. */}
              {/* Agent name + its server in one glass bubble. */}
              <span
                data-testid="chat-header-name-pill"
                className="flex flex-col items-center min-w-0 max-w-full zen-glass zen-glass-pill"
                style={{ position: "relative", zIndex: 1, marginTop: -8, padding: "10px 16px 7px" }}
              >
              <span
                data-testid="chat-header-title-row"
                className="flex items-center justify-center w-full min-w-0"
                style={{ columnGap: 4 }}
              >
                <span
                  data-testid="chat-header-title"
                  className="block min-w-0 text-[15px] font-bold truncate text-center"
                  style={{ color: "#fff" }}
                >
                  {centreTitle}
                </span>
                {extraChat && sidecarTitle ? (
                  <button
                    type="button"
                    data-testid="chat-rename-open"
                    className="shrink-0 flex items-center justify-center bg-transparent border-0 p-0"
                    style={{ color: "#fff", width: 18, height: 18, pointerEvents: "auto" }}
                    aria-label={`Rename ${sidecarTitle}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(sidecarTitle);
                      setRenameError(null);
                      setRenameOpen(true);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                ) : null}
              </span>
              <ServerChip serverId={zen.id} testId="chat-header-server" />
              </span>
              {extraChat && !drawerPicked ? (
                <button
                  type="button"
                  data-testid="chat-hide"
                  className="text-[11px] bg-transparent border-0 p-0"
                  style={{ color: "#8e8e93", pointerEvents: "auto" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (agentId) useZenStore.getState().hideSidecarChat(agentId);
                    backToChats();
                  }}
                >
                  Hide chat
                </button>
              ) : null}
              {headerSub ? (
                <span
                  className="block w-full text-[9px] tracking-widest uppercase truncate text-center"
                  style={{ color: "#f59e0b" }}
                  data-testid="chat-header-sub"
                >
                  {headerSub}
                </span>
              ) : null}
            </div>
            {/* Right column: the three buttons. The session name lives in
                the centre title now. */}
            <div
              data-testid="chat-header-right"
              className="flex flex-col items-end zen-header-text"
              style={{ marginTop: HEADER_BTN_TOP, rowGap: 6 }}
            >
            <span
              data-testid="chat-header-buttons"
              className="flex items-center"
              style={{ gap: 8, pointerEvents: "auto" }}
            >
              {/* A project chat has only Files: no Terminal, no Sessions. */}
              {groupChat ? null : (
              <>
              <button
                type="button"
                aria-label="Terminal"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={HEADER_BTN}
                onClick={(e) => {
                  e.stopPropagation();
                  rememberZenThread(agentId, roomServerId());
                  const go = async () => {
                    let tid: string | null = null;
                    if (agent) {
                      const host = await useZenStore
                        .getState()
                        .ensureSidecarHost(agent);
                      tid = host.terminalId ?? null;
                    }
                    // The room's own server's sessions (MS23): a room on
                    // another server never looks in the active one's list.
                    let sessions: GlobalSession[];
                    if (roomServerId()) {
                      const r = await getAllSessions(zen);
                      sessions = r.ok && Array.isArray(r.data) ? r.data : [];
                    } else {
                      await useWorkspacesStore.getState().fetchAllSessions();
                      sessions = useWorkspacesStore.getState().allSessions;
                    }
                    if (!tid) tid = terminalIdForAgent(agent, sessions);
                    if (!tid) {
                      // No live terminal: the Sessions drawer lists this
                      // agent's sessions (and New session) without leaving
                      // Zen for classic /sessions.
                      dismissFiles();
                      setSessionsOpen(true);
                      return;
                    }
                    openTerminal(tid, sidecarTitle);
                  };
                  void go();
                }}
              >
                <TerminalIcon size={18} strokeWidth={2} />
              </button>
              <button
                type="button"
                aria-label="Sessions"
                data-testid="chat-sessions"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={{
                  ...HEADER_BTN,
                  background: sessionsOpen ? "rgba(255,255,255,0.18)" : undefined,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (filesPaneOpen) dismissFiles();
                  setSessionsOpen((v) => !v);
                }}
              >
                {/* The old tab bar's Sessions glyph (TabBar /sessions). */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
              </>
              )}
              <button
                type="button"
                aria-label="Files"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={{
                  ...HEADER_BTN,
                  background: filesPaneOpen ? "rgba(255,255,255,0.18)" : undefined,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSessionsOpen(false);
                  if (filesPaneOpen) dismissFiles();
                  else toggleFiles();
                }}
              >
                <FileIcon size={18} strokeWidth={2} />
              </button>
            </span>
            </div>
            </div>
          </header>
          <PaneErrorBoundary name="thread">
            <ThreadPane
              viewportHeight={containerHeight}
              viewportInteractive={viewportInteractive}
              viewportMotion={viewportMotion}
              topInset={headerPx}
              covered={viewingFile}
              roomBanner={
                room.failure ? <RoomBanner failure={room.failure} onAction={room.act} /> : null
              }
              roomQueuesInput={room.failure?.queuesInput === true}
              onComposerInput={noteRoomInput}
            />
          </PaneErrorBoundary>
          {filesOpen && !viewingFile ? (
            <div
              className="absolute bottom-0 right-0 border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-pane"
              data-dragging={fileDragging ? "1" : undefined}
              style={{
                top: "env(safe-area-inset-top)",
                zIndex: 15,
                opacity: fileDragging ? 0.4 : 1,
                transform: fileDragging ? "translateX(72%)" : undefined,
                transition: "transform 180ms ease, opacity 180ms ease",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <PaneErrorBoundary name="files">
                <FilePane />
              </PaneErrorBoundary>
            </div>
          ) : null}
          {sessionsOpen && !groupChat ? (
            <div
              className="absolute bottom-0 right-0 border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="sessions-pane"
              style={{ top: "env(safe-area-inset-top)", zIndex: 15 }}
              onClick={(e) => e.stopPropagation()}
            >
              <PaneErrorBoundary name="sessions">
                <SessionsPane
                  agent={agent}
                  onClose={() => setSessionsOpen(false)}
                  onOpenTerminal={(tid, title) => {
                    rememberZenThread(agentId, roomServerId());
                    openTerminal(tid, title);
                  }}
                />
              </PaneErrorBoundary>
            </div>
          ) : null}
          {viewingFile ? (
            <div
              className="absolute bottom-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-stage"
              style={{ top: "env(safe-area-inset-top)", zIndex: 15 }}
              onClick={(e) => e.stopPropagation()}
            >
              <FileStage />
            </div>
          ) : null}
          {iconOpen && agent && iconTarget ? (
            <AgentIconSheet agent={agent} target={iconTarget} onClose={() => setIconOpen(false)} />
          ) : null}
          {renameOpen && extraChat ? (
            <div
              className="absolute inset-0 z-20 flex items-end justify-center"
              data-testid="chat-rename"
              style={{ background: "rgba(0,0,0,.55)" }}
              onClick={(e) => {
                e.stopPropagation();
                closeRename();
              }}
            >
              <form
                className="w-full px-4 pt-4 k2-tile k2-tile-sheet"
                style={{
                  borderTopLeftRadius: 14,
                  borderTopRightRadius: 14,
                  paddingBottom: "calc(16px + var(--safe-bottom))",
                }}
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  const name = renameValue.trim();
                  if (!name || !agentId || renameBusy) return;
                  setRenameBusy(true);
                  setRenameError(null);
                  void useZenStore
                    .getState()
                    .renameSidecarTitle(agentId, name)
                    .then((r) => {
                      if (r.ok) {
                        setRenameOpen(false);
                        setRenameError(null);
                      } else {
                        setRenameError(r.error || "K2 did not take the new name");
                      }
                    })
                    .finally(() => {
                      setRenameBusy(false);
                    });
                }}
              >
                <label className="block text-[12px] mb-2" style={{ color: "#8e8e93" }}>
                  Chat name
                </label>
                <input
                  data-testid="chat-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="w-full px-3 py-2 text-[16px] rounded-lg k2-tile k2-tile-raised"
                  style={{ color: "#fff" }}
                  autoFocus
                />
                {renameError ? (
                  <p
                    data-testid="chat-rename-error"
                    className="mt-2 text-[12px]"
                    style={{ color: "#ff453a" }}
                  >
                    {renameError}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2 mt-3">
                  <button
                    type="button"
                    className="px-3 py-2 text-[14px] bg-transparent border-0"
                    style={{ color: "#8e8e93" }}
                    onClick={() => setRenameOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-testid="chat-rename-save"
                    disabled={renameBusy || !renameValue.trim()}
                    className="px-3 py-2 text-[14px] bg-transparent border-0"
                    style={{ color: "#0a84ff" }}
                  >
                    Save
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </div>
        </ThreadHome>
      ) : null}
      {wantThread && room.signInOpen ? (
        // MS34 / MA3: sign in to THE ROOM's server only, never switching.
        <div
          className="fixed inset-0 flex flex-col"
          style={{ background: "#000", zIndex: 60, paddingTop: "env(safe-area-inset-top)" }}
          data-testid="room-sign-in"
        >
          <OverlayAddServer
            key={room.scope.id}
            editingId={room.scope.id}
            activate={false}
            onCancel={() => room.setSignInOpen(false)}
            onSaved={() => room.setSignInOpen(false)}
            onSignedIn={(id) => {
              room.setSignInOpen(false);
              void pool.check(id);
              const z = useZenStore.getState();
              if (z.agentId) void z.hydrateAgents({ resumeId: z.agentId });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Fixed thread backdrop. A left-edge swipe acts like the header's top-left
 *  control: Back (to the chats list or Projects), or Done while the chat
 *  was picked from the Sessions drawer (own component so the swipe hook
 *  binds when the thread mounts, not when Zen does). */
function ThreadHome({
  children,
  onSwipeBack,
  swipeEnabled,
  onSwipeDrag,
  top = 0,
}: {
  children: ReactNode;
  onSwipeBack: () => void;
  /** Read at each touch start. */
  swipeEnabled: () => boolean;
  onSwipeDrag?: (dragging: boolean) => void;
  /** visualViewport.offsetTop left after the scroll reset (0 normally). */
  top?: number;
}) {
  const swipeRef = useSwipeBack(onSwipeBack, { enabled: swipeEnabled, onDragChange: onSwipeDrag });
  return (
    <div
      ref={swipeRef}
      className="fixed inset-0"
      data-testid="thread-home"
      style={{
        position: "fixed",
        top,
        left: 0,
        right: 0,
        bottom: 0,
        background: "#000",
      }}
    >
      {children}
    </div>
  );
}
