import { useEffect } from "react";
import { ChatsList } from "../zen/ChatsList";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { PaneErrorBoundary } from "../zen/PaneErrorBoundary";
import { ThreadPane } from "../zen/ThreadPane";
import { STUB_BANNER } from "../zen/stubData";
import { useZenStore, sourceWord } from "../zen/zenStore";

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
  const toggleFiles = useZenStore((s) => s.toggleFiles);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const agent = agents.find((a) => a.id === agentId);
  const filesOpen = openFileIds.length > 0;

  useEffect(() => {
    void hydrateAgents();
  }, [hydrateAgents]);

  const banner =
    agentSource === "stub" && fileSource === "stub"
      ? STUB_BANNER
      : `${sourceWord(agentSource)} agents · ${sourceWord(fileSource)} files`;
  const err = [agentError, fileError].filter(Boolean).join(" · ");

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
          <div className="relative flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden">
            <header
              className="flex items-center gap-2 px-3 shrink-0"
              style={{
                minHeight: 44,
                paddingTop: "max(8px, env(safe-area-inset-top))",
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
                <span
                  className="block w-full text-[9px] tracking-widest uppercase truncate text-center"
                  style={{ color: "#f59e0b" }}
                >
                  {banner}
                  {err ? ` · ${err}` : ""}
                </span>
              </div>
              <button
                type="button"
                onClick={() => toggleFiles()}
                aria-label="Files"
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "#1c1c1e",
                  color: "#fff",
                }}
              >
                ⌁
              </button>
            </header>
            <PaneErrorBoundary name="thread">
              <ThreadPane />
            </PaneErrorBoundary>
            {filesOpen && (
              <div className="absolute inset-y-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col">
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
