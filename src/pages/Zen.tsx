import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useViewportHeight } from "../lib/useViewportHeight";
import { WorkspaceAvatar } from "../zen/WorkspaceAvatar";
import { useWorkspacesStore } from "../stores/workspaces";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { SessionsPane } from "../zen/SessionsPane";
import { useSwipeBack } from "../lib/useSwipeBack";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import {
  ZEN_ADDR_PARAM,
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
import { STUB_BANNER } from "../zen/stubData";
import { isOverlayExtraAddr, threadHeaderTitle, threadSidecarTitle } from "../zen/overlayExtras";
import { useZenStore } from "../zen/zenStore";
import { AgentIconSheet } from "../zen/AgentIconSheet";
import { canChangeIcon, iconTargetFor } from "../zen/workspaceIcon";
import { useSessionIdentity } from "../lib/useSessionIdentity";

const HEADER_BTN: CSSProperties = {
  width: 36,
  height: 36,
  color: "#fff",
};

/** iMessage contact photo above the name. */
const HEADER_AVATAR_PX = 42;
/** Resting header content height (below the safe area): avatar + name. */
export const CHAT_HEADER_PX = 84;
/** Buttons centre on the avatar. */
const HEADER_BTN_TOP = (HEADER_AVATAR_PX - 36) / 2;

export function Zen() {
  const navigate = useNavigate();
  const containerHeight = useViewportHeight();
  const [params, setParams] = useSearchParams();
  const threadParam = params.get("thread");
  // Terminal Done: `/zen?addr=<session addr>` (+ state.zenReturn).
  const addrParam = (params.get(ZEN_ADDR_PARAM) || "").trim();
  const location = useLocation();
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
  /** Opened from the Sessions drawer: Done (not Back) returns to the origin. */
  const drawerPicked = Boolean(drawerOrigin) && drawerOrigin !== agentId;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const extraChat = isOverlayExtraAddr(agent?.addr);
  const headerTitle = threadHeaderTitle(agent);
  const sidecarTitle = threadSidecarTitle(agent);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerPx, setHeaderPx] = useState(CHAT_HEADER_PX);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const serverProjects = useZenStore((s) => s.serverProjects);
  const identity = useSessionIdentity();
  const [iconOpen, setIconOpen] = useState(false);
  // Header avatar → Change icon: the workspace's (a sidecar edits its parent's).
  const iconTarget = canChangeIcon(identity) ? iconTargetFor(agent, serverProjects) : null;
  const viewingFile = openFileIds.length > 0;
  const filesPaneOpen = filesOpen || viewingFile;

  // A different chat closes the Sessions drawer (and the icon sheet).
  useEffect(() => {
    setSessionsOpen(false);
    setIconOpen(false);
  }, [agentId]);

  const openTerminal = (tid: string, chatTitle: string | null) => {
    // Done on the terminal returns to this exact Thread (Done mode, origin).
    const back = zenTerminalReturn(agent, tid, drawerOrigin);
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
        }
      : null;
    navigate(zenTerminalPath(tid), {
      state: ctx ? { agent: ctx } : undefined,
    });
  };
  // ?thread= paints the thread on first frame (no chats-list flash). After
  // Back, ignore that query until it is stripped, or closeChat leaves an em dash.
  const [ignoreThreadQuery, setIgnoreThreadQuery] = useState(false);
  const skipHydrateOnClear = useRef(false);
  const wantThread =
    screen === "thread" ||
    (Boolean((threadParam || "").trim() || addrParam) && !ignoreThreadQuery);

  // `?addr=` reopens that session's Thread before paint. The cold
  // hydrate below must not run over it (it ends Done mode).
  const zenReturn = readZenReturnState(location.state, addrParam);
  const zenReturnKey = zenReturn ? JSON.stringify(zenReturn) : "";
  useLayoutEffect(() => {
    if (!addrParam) return;
    setIgnoreThreadQuery(false);
    void resumeSessionThread(addrParam, zenReturnKey ? JSON.parse(zenReturnKey) : null);
  }, [addrParam, zenReturnKey]);

  // Chat return (`?thread=`) must first-paint LOADING, never leftover bubbles.
  // hydrateAgents is useEffect (after paint); this runs before paint.
  useLayoutEffect(() => {
    const id = (threadParam || "").trim();
    if (!id || ignoreThreadQuery) return;
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
  }, [threadParam, ignoreThreadQuery]);

  useEffect(() => {
    const id = (threadParam || "").trim();
    if (id) {
      setIgnoreThreadQuery(false);
      void hydrateAgents({ resumeId: id });
      return;
    }
    if (addrParam) return;
    if (skipHydrateOnClear.current) {
      skipHydrateOnClear.current = false;
      return;
    }
    void hydrateAgents();
  }, [hydrateAgents, threadParam, addrParam]);

  const backToChats = () => {
    // closeChat is zustand-sync and would re-render with the query still
    // holding the thread column (empty name, em dash). Dismiss first.
    flushSync(() => setIgnoreThreadQuery(true));
    closeChat();
    if ((threadParam || "").trim() || addrParam) {
      skipHydrateOnClear.current = true;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("thread");
          next.delete(ZEN_ADDR_PARAM);
          return next;
        },
        { replace: true }
      );
    }
  };

  // The header floats over the list; the list's top padding tracks the
  // header's real height (sidecar line, Hide chat, banner grow it).
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
        className="h-full min-h-0"
        data-testid="chats-layer"
        style={
          wantThread
            ? {
                visibility: "hidden",
                position: "absolute",
                inset: 0,
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
          onSwipeBack={returnToDrawerOrigin}
          swipeEnabled={drawerPicked && !filesPaneOpen && !sessionsOpen}
        >
        <div
          className="relative flex flex-col min-h-0 overflow-x-hidden"
          data-testid="thread-column"
          style={{ height: containerHeight }}
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
              style={{ ...HEADER_BTN, marginTop: HEADER_BTN_TOP, pointerEvents: "auto" }}
              aria-label="Back to chats"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            )}
            <div className="min-w-0 flex flex-col items-center justify-center zen-header-text">
              {iconTarget ? (
                <button
                  type="button"
                  data-testid="chat-header-avatar"
                  className="flex mb-1 bg-transparent border-0 p-0"
                  style={{ borderRadius: "50%", pointerEvents: "auto" }}
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
                <span data-testid="chat-header-avatar" className="flex mb-1">
                  <WorkspaceAvatar
                    initial={agent?.initial || headerTitle.slice(0, 1) || "?"}
                    color={agent?.color}
                    iconUrl={agent?.iconUrl}
                    size={HEADER_AVATAR_PX}
                    fontSize={16}
                    fallback="#2c2c2e"
                  />
                </span>
              )}
              <span
                data-testid="chat-header-title"
                className="block w-full text-[15px] font-bold truncate text-center"
                style={{ color: "#fff" }}
              >
                {headerTitle}
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
            {/* Right column: the three buttons, then the session name
                right-aligned under them (white, so it reads over the blur). */}
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
              <button
                type="button"
                aria-label="Terminal"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={HEADER_BTN}
                onClick={(e) => {
                  e.stopPropagation();
                  rememberZenThread(agentId);
                  const go = async () => {
                    let tid: string | null = null;
                    if (agent) {
                      const host = await useZenStore
                        .getState()
                        .ensureSidecarHost(agent);
                      tid = host.terminalId ?? null;
                    }
                    await useWorkspacesStore.getState().fetchAllSessions();
                    const sessions = useWorkspacesStore.getState().allSessions;
                    if (!tid) tid = terminalIdForAgent(agent, sessions);
                    if (!tid) {
                      navigate("/sessions");
                      return;
                    }
                    openTerminal(tid, sidecarTitle);
                  };
                  void go();
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
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
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </button>
            </span>
              {sidecarTitle ? (
                <span
                  data-testid="chat-session-line"
                  className="zen-header-session flex items-center justify-end gap-1"
                >
                  <span
                    data-testid="chat-sidecar-title"
                    className="truncate min-w-0 text-[12.5px] font-medium text-right"
                    style={{ color: "#fff" }}
                  >
                    {drawerPicked ? agent?.addr : sidecarTitle}
                  </span>
                  {extraChat ? (
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
              ) : null}
            </div>
            </div>
          </header>
          <PaneErrorBoundary name="thread">
            <ThreadPane viewportHeight={containerHeight} topInset={headerPx} />
          </PaneErrorBoundary>
          {filesOpen && !viewingFile ? (
            <div
              className="absolute bottom-0 right-0 border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-pane"
              style={{ top: "env(safe-area-inset-top)", zIndex: 15 }}
              onClick={(e) => e.stopPropagation()}
            >
              <PaneErrorBoundary name="files">
                <FilePane />
              </PaneErrorBoundary>
            </div>
          ) : null}
          {sessionsOpen ? (
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
                    rememberZenThread(agentId);
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
                if (!renameBusy) {
                  setRenameOpen(false);
                  setRenameError(null);
                }
              }}
            >
              <form
                className="w-full px-4 pt-4 k2-tile k2-tile-sheet"
                style={{
                  borderTopLeftRadius: 14,
                  borderTopRightRadius: 14,
                  paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
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
    </div>
  );
}

/** Fixed thread backdrop. A left-edge swipe acts like Done while the chat
 *  was picked from the Sessions drawer (own component so the swipe hook
 *  binds when the thread mounts, not when Zen does). */
function ThreadHome({
  children,
  onSwipeBack,
  swipeEnabled,
}: {
  children: ReactNode;
  onSwipeBack: () => void;
  swipeEnabled: boolean;
}) {
  const swipeRef = useSwipeBack(onSwipeBack, { enabled: swipeEnabled });
  return (
    <div
      ref={swipeRef}
      className="fixed inset-0"
      data-testid="thread-home"
      style={{
        position: "fixed",
        top: 0,
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
