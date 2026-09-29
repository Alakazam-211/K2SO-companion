import { useZenStore } from "./zenStore";

export function AgentRail() {
  const agentId = useZenStore((s) => s.agentId);
  const setAgent = useZenStore((s) => s.setAgent);
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);

  return (
    <aside
      className="flex flex-col items-center gap-2 py-3 border-r border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: 52 }}
      aria-label="Agents"
    >
      <span className="text-[8px] text-[var(--text-muted)] tracking-widest uppercase px-1 text-center leading-tight">
        {source === "live" ? "LIVE" : "STUB"}
      </span>
      {agents.map((a) => {
        const on = a.id === agentId;
        return (
          <button
            key={a.id}
            onClick={() => setAgent(a.id)}
            title={a.name}
            className={`w-9 h-9 flex items-center justify-center text-[12px] font-semibold border ${
              on
                ? "border-[var(--accent-dim)] text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--text-muted)]"
            }`}
          >
            {a.initial}
          </button>
        );
      })}
    </aside>
  );
}
