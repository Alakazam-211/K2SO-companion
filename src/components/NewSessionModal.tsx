import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";
import * as api from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewSessionModal({ open, onClose }: Props) {
  const projects = useWorkspacesStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [launching, setLaunching] = useState(false);
  const [viewHeight, setViewHeight] = useState(window.innerHeight);
  const navigate = useNavigate();

  // Track visual viewport so modal stays above keyboard
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setViewHeight(vv.height);
    onResize();
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [open]);

  if (!open) return null;

  const filtered = projects
    .filter((p) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const handleLaunch = async (projectPath: string) => {
    setLaunching(true);
    const r = await api.spawnBackgroundTerminal(projectPath, "claude", projectPath);
    setLaunching(false);
    if (r.ok && r.data?.terminalId) {
      onClose();
      setQuery("");
      await useWorkspacesStore.getState().fetchAllSessions();
      navigate(`/chat/${r.data.terminalId}`);
      return;
    }
    await useWorkspacesStore.getState().fetchAllSessions();
    onClose();
    setQuery("");
  };

  return (
    <div
      className="fixed z-50 flex flex-col justify-end"
      style={{ top: 0, left: 0, right: 0, height: viewHeight }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-full bg-[var(--surface)] border-t border-[var(--border)] flex flex-col"
        style={{ maxHeight: viewHeight * 0.7 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]" style={{ flexShrink: 0 }}>
          <span className="text-[var(--text)] text-[13px] font-semibold">
            New Session
          </span>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] text-[11px]"
          >
            Cancel
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[var(--border)]" style={{ flexShrink: 0 }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspaces..."
            className="w-full bg-[var(--background)] border border-[var(--border)] px-3 py-2 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)]"
          />
        </div>

        {/* Workspace list */}
        <div className="overflow-y-auto flex-1">
          {launching ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-[var(--accent)] text-[13px]">Launching...</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-[var(--text-muted)] text-[13px]">No matching workspaces</span>
            </div>
          ) : (
            <div className="p-2 flex flex-col gap-1">
              {filtered.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleLaunch(project.path)}
                  className="flex items-center gap-3 px-3 py-3 hover:bg-[var(--background)] transition-colors text-left w-full"
                >
                  <div
                    className="w-8 h-8 flex items-center justify-center text-[11px] font-bold shrink-0"
                    style={{ backgroundColor: project.color || "var(--accent)", color: "#000" }}
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[var(--text)] text-[13px] truncate">
                      {project.name}
                    </div>
                    <div className="text-[var(--text-muted)] text-[11px] truncate">
                      {project.path.split("/").slice(-2).join("/")}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
