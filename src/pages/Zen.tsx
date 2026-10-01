import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import { rememberZenThread, terminalIdForAgent } from "../zen/terminalJump";
import { ThreadPane } from "../zen/ThreadPane";
import { STUB_BANNER } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";

const HEADER_BTN: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "50%",
  background: "#1c1c1e",
  color: "#fff",
};

export function Zen() {
  const navigate = useNavigate();
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
        <div
          className="relative flex flex-col h-full min-h-0 overflow-x-hidden"
          data-testid="thread-column"
          onClick={filesPaneOpen ? () => dismissFiles() : undefined}
        >
          <header
            className="grid items-center shrink-0 w-full min-w-0 px-3"
            style={{
              gridTemplateColumns: "1fr auto 1fr",
              minHeight: 44,
              paddingTop: 8,
              background: "#000",
              columnGap: 8,
            }}
          >
            <button
              type="button"
              onClick={backToChats}
              data-testid="chat-back"
              className="flex items-center justify-center shrink-0 justify-self-start"
              style={HEADER_BTN}
              aria-label="Back to chats"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div className="min-w-0 flex flex-col items-center justify-center">
              <span
                className="block w-full text-[15px] font-bold truncate text-center"
                style={{ color: "#fff" }}
              >
                {agent?.name ?? "—"}
              </span>
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
                className="flex items-center justify-center shrink-0"
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
                className="flex items-center justify-center shrink-0"
                style={{
                  ...HEADER_BTN,
                  background: filesPaneOpen ? "#3a3a3c" : "#1c1c1e",
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
            <ThreadPane />
          </PaneErrorBoundary>
          {filesOpen && !viewingFile ? (
            <div
              className="absolute inset-y-0 right-0 border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-pane"
              onClick={(e) => e.stopPropagation()}
            >
              <PaneErrorBoundary name="files">
                <FilePane />
              </PaneErrorBoundary>
            </div>
          ) : null}
          {viewingFile ? (
            <div
              className="absolute inset-y-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
              data-testid="file-stage"
              onClick={(e) => e.stopPropagation()}
            >
              <FileStage />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
