import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";

export function Sessions() {
  const allSessions = useWorkspacesStore((s) => s.allSessions);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  // Sort alphabetically by label, filter by search
  const filtered = allSessions
    .filter((s) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        s.label.toLowerCase().includes(q) ||
        s.workspaceName.toLowerCase().includes(q) ||
        s.agentName.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col h-full pb-safe">
      {/* Search bar — only visible when triggered from header */}
      {query !== "" && (
        <div className="px-4 pt-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
            className="w-full bg-[var(--background)] border border-[var(--border)] px-3 py-2 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)]"
          />
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 gap-2">
            <span className="text-[var(--text-muted)] text-[13px]">
              {allSessions.length === 0
                ? "No active sessions"
                : "No matching sessions"}
            </span>
            {allSessions.length === 0 && (
              <span className="text-[var(--text-muted)] text-[11px] opacity-60">
                Tap + to start a new session
              </span>
            )}
          </div>
        ) : (
          <div className="py-2 px-1.5 flex flex-col gap-1">
            {filtered.map((session) => (
              <button
                key={session.terminalId}
                onClick={() => navigate(`/chat/${session.terminalId}`)}
                className="flex items-center gap-3 px-3 py-3 bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-colors text-left w-full"
              >
                {/* Workspace color bar */}
                <div
                  className="w-1 self-stretch shrink-0"
                  style={{ backgroundColor: session.workspaceColor || "var(--accent)" }}
                />
                {/* Session info */}
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text)] text-[13px] truncate">
                    {session.label || session.agentName}
                  </div>
                  <div className="text-[var(--text-muted)] text-[11px] truncate">
                    {session.workspaceName}
                  </div>
                </div>
                {/* Online indicator */}
                <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
