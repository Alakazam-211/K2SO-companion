import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AgentRail } from "../zen/AgentRail";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { StubMark } from "../zen/StubMark";
import { STUB_BANNER, STUB_THREAD, STUB_THREAD_FALLBACK } from "../zen/stubData";
import { useZenStore, sourceWord } from "../zen/zenStore";

export function Zen() {
  const navigate = useNavigate();
  const agentId = useZenStore((s) => s.agentId);
  const agents = useZenStore((s) => s.agents);
  const agentSource = useZenStore((s) => s.agentSource);
  const fileSource = useZenStore((s) => s.fileSource);
  const agentError = useZenStore((s) => s.agentError);
  const fileError = useZenStore((s) => s.fileError);
  const hydrateAgents = useZenStore((s) => s.hydrateAgents);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const thread = (agent && STUB_THREAD[agent.id]) || STUB_THREAD_FALLBACK;
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
    <div className="flex h-full min-h-0 bg-[var(--background)]">
      <AgentRail />
      <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
        <header className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--chrome)] shrink-0">
          <button
            onClick={() => navigate("/servers")}
            className="text-[var(--text-muted)] text-[11px]"
          >
            Leave
          </button>
          <span className="text-[var(--text)] text-[13px] font-semibold truncate">
            {agent?.name ?? "—"}
          </span>
          <span className="text-[var(--warning)] text-[9px] tracking-widest uppercase truncate">
            {banner}
            {err ? ` · ${err}` : ""}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {thread.map((m, i) => (
            <div
              key={i}
              className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2 theme-radius"
            >
              <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] mb-1">
                <StubMark />
                <span>{m.author}</span>
              </div>
              <div className="text-[13px] text-[var(--text)]">{m.text}</div>
            </div>
          ))}
        </div>
        {filesOpen && (
          <div className="absolute inset-y-0 right-0 w-[78%] border-l border-[var(--border)] bg-[var(--background)] flex flex-col">
            <FileStage />
          </div>
        )}
      </div>
      <FilePane />
    </div>
  );
}
