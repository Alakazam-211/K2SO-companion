import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useWorkspacesStore } from "../stores/workspaces";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import { rememberZenThread, terminalIdForAgent } from "../zen/terminalJump";
import { ThreadPane } from "../zen/ThreadPane";
import { STUB_BANNER } from "../zen/stubData";
import { isOverlayExtraAddr, threadHeaderTitle, threadSidecarTitle } from "../zen/overlayExtras";
import { useZenStore } from "../zen/zenStore";

const HEADER_BTN: CSSProperties = {
  width: 36,
  height: 36,
  color: "#fff",
};

export function Zen() {
  const navigate = useNavigate();
  const containerHeight = useViewportHeight();
  const [params, setParams] = useSearchParams();
  const threadParam = params.get("thread");
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
  const agent = agents.find((a) => a.id === agentId);
  const extraChat = isOverlayExtraAddr(agent?.addr);
  const headerTitle = threadHeaderTitle(agent);
  const sidecarTitle = threadSidecarTitle(agent);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const viewingFile = openFileIds.length > 0;
  const filesPaneOpen = filesOpen || viewingFile;
  // ?thread= paints the thread on first frame (no chats-list flash). After
  // Back, ignore that query until it is stripped, or closeChat leaves an em dash.
  const [ignoreThreadQuery, setIgnoreThreadQuery] = useState(false);
  const skipHydrateOnClear = useRef(false);
  const wantThread =
    screen === "thread" ||
    (Boolean((threadParam || "").trim()) && !ignoreThreadQuery);

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
    if (skipHydrateOnClear.current) {
      skipHydrateOnClear.current = false;
      return;
    }
    void hydrateAgents();
  }, [hydrateAgents, threadParam]);

  const backToChats = () => {
    // closeChat is zustand-sync and would re-render with the query still
    // holding the thread column (empty name, em dash). Dismiss first.
    flushSync(() => setIgnoreThreadQuery(true));
    closeChat();
    if ((threadParam || "").trim()) {
      skipHydrateOnClear.current = true;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("thread");
          return next;
        },
        { replace: true }
      );
    }
  };

  const stubBanner =
    agentSource === "stub" && fileSource === "stub" ? STUB_BANNER : "";
  const err = [agentError, fileError].filter(Boolean).join(" · ");
  const headerSub = [stubBanner, err].filter(Boolean).join(" · ");

  return (
    <div className="relative h-full min-h-0" style={{ background: "#000" }}>
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
        <div
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
        <div
          className="relative flex flex-col min-h-0 overflow-x-hidden"
          data-testid="thread-column"
          style={{
            height: containerHeight,
            paddingTop: "env(safe-area-inset-top)",
          }}
          onClick={filesPaneOpen ? () => dismissFiles() : undefined}
        >
          <header
            className="grid items-center shrink-0 w-full min-w-0 px-3"
            data-testid="chat-header"
            style={{
              gridTemplateColumns: "1fr auto 1fr",
              minHeight: 44,
              paddingTop: 12,
              paddingBottom: 12,
              background: "#000",
              columnGap: 8,
            }}
          >
            <button
              type="button"
              onClick={backToChats}
              data-testid="chat-back"
              className="flex items-center justify-center shrink-0 justify-self-start zen-glass zen-glass-pill"
              style={HEADER_BTN}
              aria-label="Back to chats"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div className="min-w-0 flex flex-col items-center justify-center">
              <span
                data-testid="chat-header-title"
                className="block w-full text-[15px] font-bold truncate text-center"
                style={{ color: "#fff" }}
              >
                {headerTitle}
              </span>
              {sidecarTitle ? (
                <span className="flex items-center justify-center gap-1 min-w-0 max-w-full">
                  <span
                    data-testid="chat-sidecar-title"
                    className="text-[12px] truncate"
                    style={{ color: "#8e8e93" }}
                  >
                    {sidecarTitle}
                  </span>
                  {extraChat ? (
                    <button
                      type="button"
                      data-testid="chat-rename-open"
                      className="shrink-0 flex items-center justify-center bg-transparent border-0 p-0"
                      style={{ color: "#8e8e93", width: 18, height: 18 }}
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
              {extraChat ? (
                <button
                  type="button"
                  data-testid="chat-hide"
                  className="text-[11px] bg-transparent border-0 p-0"
                  style={{ color: "#8e8e93" }}
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
            <span className="flex items-center justify-self-end" style={{ gap: 8 }}>
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
                    navigate(tid ? `/chat/${tid}` : "/sessions");
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
                aria-label="Files"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={{
                  ...HEADER_BTN,
                  background: filesPaneOpen ? "rgba(255,255,255,0.18)" : undefined,
                }}
                onClick={(e) => {
                  e.stopPropagation();
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
          </header>
          <PaneErrorBoundary name="thread">
            <ThreadPane viewportHeight={containerHeight} />
          </PaneErrorBoundary>
          {filesOpen && !viewingFile ? (
            <div
              className="absolute bottom-0 right-0 border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-pane"
              style={{ top: "env(safe-area-inset-top)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <PaneErrorBoundary name="files">
                <FilePane />
              </PaneErrorBoundary>
            </div>
          ) : null}
          {viewingFile ? (
            <div
              className="absolute bottom-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-stage"
              style={{ top: "env(safe-area-inset-top)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <FileStage />
            </div>
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
        </div>
      ) : null}
    </div>
  );
}
