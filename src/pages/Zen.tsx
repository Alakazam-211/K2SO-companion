import { useEffect } from "react";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import { ThreadPane } from "../zen/ThreadPane";
import { STUB_BANNER } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";

export function Zen() {
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
  const openFileIds = useZenStore((s) => s.openFileIds);
  const agent = agents.find((a) => a.id === agentId);
  const viewingFile = openFileIds.length > 0;

  useEffect(() => {
    void hydrateAgents();
  }, [hydrateAgents]);

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
          screen === "list"
            ? undefined
            : {
                visibility: "hidden",
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
              }
        }
        aria-hidden={screen !== "list"}
      >
        <ChatsList />
      </div>
      {screen === "thread" ? (
        <div className="flex h-full min-h-0">
          <div
            className="relative flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden"
            data-testid="thread-column"
            onClick={viewingFile ? () => dismissFiles() : undefined}
          >
            <header
              className="flex items-center gap-2 px-3 shrink-0"
              style={{
                minHeight: 44,
                paddingTop: 8,
                background: "#000",
              }}
            >
              <button
                onClick={() => closeChat()}
                className="text-[17px] font-semibold shrink-0"
                style={{
                  minHeight: 34,
                  padding: "0 10px 0 6px",
                  borderRadius: 17,
                  background: "#1c1c1e",
                  color: "#fff",
                }}
                aria-label="Back to chats"
              >
                ‹
              </button>
              <div className="flex-1 min-w-0 flex flex-col items-center justify-center">
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
              <span style={{ width: 36 }} aria-hidden />
            </header>
            <PaneErrorBoundary name="thread">
              <ThreadPane />
            </PaneErrorBoundary>
            {viewingFile && (
              <div
                className="absolute inset-y-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col"
                data-testid="file-stage"
                onClick={(e) => e.stopPropagation()}
              >
                <FileStage />
              </div>
            )}
          </div>
          <PaneErrorBoundary name="files">
            <FilePane />
          </PaneErrorBoundary>
        </div>
      ) : null}
    </div>
  );
}
