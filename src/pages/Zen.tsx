import { useNavigate } from "react-router-dom";
import { AgentRail } from "../zen/AgentRail";
import { FilePane } from "../zen/FilePane";
import { FileStage } from "../zen/FileStage";
import { STUB_AGENTS, STUB_BANNER, STUB_THREAD } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";

export function Zen() {
  const navigate = useNavigate();
  const agentId = useZenStore((s) => s.agentId);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const agent = STUB_AGENTS.find((a) => a.id === agentId) ?? STUB_AGENTS[0];
  const thread = STUB_THREAD[agent.id] ?? [];
  const filesOpen = openFileIds.length > 0;

  return (
    <div className="flex h-full min-h-0 bg-[var(--background)]">
      <AgentRail />
      <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
        <header className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] shrink-0">
          <button
            onClick={() => navigate("/servers")}
            className="text-[var(--text-muted)] text-[11px]"
          >
            Leave
          </button>
          <span className="text-[var(--text)] text-[13px] font-semibold truncate">
            {agent.name}
          </span>
          <span className="text-[var(--warning)] text-[9px] tracking-widest uppercase truncate">
            {STUB_BANNER}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {thread.map((m, i) => (
            <div
              key={i}
              className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="text-[10px] text-[var(--text-muted)] mb-1">
                {m.author}
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
