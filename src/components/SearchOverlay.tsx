import { useState } from "react";
import { useWorkspacesStore } from "../stores/workspaces";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchOverlay({ open, onClose }: Props) {
  const { projects, setActiveProject, summaryFor } = useWorkspacesStore();
  const [query, setQuery] = useState("");

  if (!open) return null;

  const filtered = query.trim()
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.path.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  const handleSelect = (id: string) => {
    setActiveProject(id);
    setQuery("");
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      <div className="fixed top-0 left-0 right-0 z-50 bg-[var(--background)] border-b border-[var(--border)]" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" className="shrink-0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspaces..."
            autoFocus
            className="flex-1 bg-transparent text-[var(--text)] text-[13px] focus:outline-none"
          />
          <button
            onClick={() => { setQuery(""); onClose(); }}
            className="text-[var(--text-muted)] text-[11px] shrink-0"
          >
            Cancel
          </button>
        </div>

        {query.trim() && (
          <div className="max-h-[60vh] overflow-y-auto px-2 pb-3">
            {filtered.length === 0 ? (
              <p className="text-[var(--text-muted)] text-[11px] text-center py-6">No matching workspaces</p>
            ) : (
              filtered.map((p) => {
                const s = summaryFor(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => handleSelect(p.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/[0.04] transition-colors"
                  >
                    <span
                      className="w-5 h-5 shrink-0 flex items-center justify-center text-[9px] font-bold text-black"
                      style={{ background: p.color }}
                    >
                      {p.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[var(--text)] text-[12px] font-medium block truncate">{p.name}</span>
                      {p.focusGroup && (
                        <span className="text-[var(--text-muted)] text-[9px] block truncate">{p.focusGroup.name}</span>
                      )}
                    </div>
                    {s && s.agentsRunning > 0 && (
                      <span className="text-[9px] text-[var(--success)] shrink-0">{s.agentsRunning} running</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </>
  );
}
