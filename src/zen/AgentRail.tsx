import { StubMark } from "./StubMark";
import { useZenStore, sourceWord } from "./zenStore";

export function AgentRail() {
  const agentId = useZenStore((s) => s.agentId);
  const setAgent = useZenStore((s) => s.setAgent);
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);
  const agentError = useZenStore((s) => s.agentError);

  return (
    <aside
      className="flex flex-col h-full min-h-0 border-r border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: 72 }}
      aria-label="Agents"
    >
      <span className="text-[8px] text-[var(--text-muted)] tracking-widest uppercase px-1 py-2 text-center leading-tight shrink-0">
        {sourceWord(source)}
      </span>
      <div
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        style={{ WebkitOverflowScrolling: "touch" }}
        data-testid="agent-rail-scroll"
      >
        {agents.map((a) => {
          const on = a.id === agentId;
          return (
            <div key={a.id} className="flex flex-col items-center gap-0.5 px-1 py-1">
              <button
                onClick={() => setAgent(a.id)}
                title={a.name}
                aria-label={source === "stub" ? `STUB ${a.name}` : a.name}
                className={`w-9 h-9 flex items-center justify-center text-[11px] font-semibold border shrink-0 ${
                  on
                    ? "border-[var(--accent-dim)] text-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {a.initial}
              </button>
              <span className="w-full text-[8px] leading-tight text-center truncate text-[var(--text-secondary)]">
                {a.name}
              </span>
              {source === "live" && !a.addr ? (
                <span className="text-[7px] text-[var(--warning)] leading-tight text-center">
                  no chat
                </span>
              ) : null}
              {source === "stub" ? <StubMark /> : null}
            </div>
          );
        })}
        {source !== "loading" && agents.length === 0 ? (
          <div
            className="px-1 py-2 text-center leading-tight"
            data-testid="agent-rail-empty"
          >
            {source === "error" && agentError ? (
              <span className="text-[8px] text-[var(--warning)]">{agentError}</span>
            ) : (
              <>
                <span className="block text-[8px] text-[var(--text-muted)] tracking-widest uppercase">
                  No chats
                </span>
                <span className="block mt-1 text-[8px] text-[var(--text-secondary)]">
                  No agents on this list.
                </span>
              </>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
