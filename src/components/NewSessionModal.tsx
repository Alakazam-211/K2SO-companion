import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";
import * as api from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Picked = { path: string; name: string };

export function NewSessionModal({ open, onClose }: Props) {
  const projects = useWorkspacesStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [launching, setLaunching] = useState(false);
  // Step 2: a workspace was picked; choose main chat tab vs new tab.
  const [picked, setPicked] = useState<Picked | null>(null);
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

  // Reset all step state and dismiss.
  const close = () => {
    setQuery("");
    setPicked(null);
    setLaunching(false);
    onClose();
  };

  // Step 2a — open (or resume) the workspace's pinned main chat session.
  const openMainChat = async (projectPath: string) => {
    setLaunching(true);
    const r = await api.ensurePinnedChat(projectPath);
    await useWorkspacesStore.getState().fetchAllSessions();
    setLaunching(false);
    if (r.ok && r.data?.sessionId) {
      const id = r.data.sessionId;
      close();
      navigate(`/chat/${id}`);
    }
  };

  // Step 2b — spawn a fresh terminal tab in the workspace.
  const openNewTab = async (projectPath: string) => {
    setLaunching(true);
    const r = await api.spawnBackgroundTerminal(projectPath, "claude", projectPath);
    await useWorkspacesStore.getState().fetchAllSessions();
    setLaunching(false);
    if (r.ok && r.data?.terminalId) {
      const id = r.data.terminalId;
      close();
      navigate(`/chat/${id}`);
    }
  };

  return (
    <div
      className="fixed z-50 flex flex-col justify-end"
      style={{ top: 0, left: 0, right: 0, height: viewHeight }}
      onClick={close}
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
          {picked ? (
            <button
              onClick={() => setPicked(null)}
              className="flex items-center gap-1.5 text-[var(--accent)] text-[13px] font-semibold"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 1L3 7l6 6" /></svg>
              <span className="truncate">{picked.name}</span>
            </button>
          ) : (
            <span className="text-[var(--text)] text-[13px] font-semibold">
              New Session
            </span>
          )}
          <button
            onClick={close}
            className="text-[var(--text-muted)] text-[11px]"
          >
            Cancel
          </button>
        </div>

        {/* Search — step 1 only */}
        {!picked && (
          <div className="px-4 py-2 border-b border-[var(--border)]" style={{ flexShrink: 0 }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces..."
              className="w-full bg-[var(--background)] border border-[var(--border)] px-3 py-2 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)]"
            />
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto flex-1">
          {launching ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-[var(--accent)] text-[13px]">Launching...</span>
            </div>
          ) : picked ? (
            /* Step 2 — choose which tab to open */
            <div className="p-3 flex flex-col gap-2">
              <button
                onClick={() => openMainChat(picked.path)}
                className="flex flex-col gap-0.5 px-4 py-3.5 bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent-dim)] transition-colors text-left w-full"
              >
                <span className="text-[var(--text)] text-[13px] font-semibold">Open main chat tab</span>
                <span className="text-[var(--text-muted)] text-[11px]">Resume this workspace's primary chat session</span>
              </button>
              <button
                onClick={() => openNewTab(picked.path)}
                className="flex flex-col gap-0.5 px-4 py-3.5 bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent-dim)] transition-colors text-left w-full"
              >
                <span className="text-[var(--text)] text-[13px] font-semibold">Open new tab</span>
                <span className="text-[var(--text-muted)] text-[11px]">Start a fresh terminal in this workspace</span>
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-[var(--text-muted)] text-[13px]">No matching workspaces</span>
            </div>
          ) : (
            /* Step 1 — pick a workspace */
            <div className="p-2 flex flex-col gap-1">
              {filtered.map((project) => (
                <button
                  key={project.id}
                  onClick={() => setPicked({ path: project.path, name: project.name })}
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
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--text-muted)" strokeWidth="2" className="shrink-0"><path d="M5 1l6 6-6 6" /></svg>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
