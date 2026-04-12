import { useState, useRef, useLayoutEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api/client";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";

export function ChatSession() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const session = useWorkspacesStore((s) =>
    s.allSessions.find((sess) => sess.terminalId === terminalId)
  );
  const projectPath = session?.cwd || "";
  const [input, setInput] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize: runs before paint so intermediate height=0 is never visible
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    const h = Math.min(Math.max(el.scrollHeight, 40), 100);
    el.style.height = h + "px";
    el.style.overflow = el.scrollHeight > 100 ? "auto" : "hidden";
  }, [input]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !terminalId || !projectPath) return;
    setInput("");
    await api.writeTerminal(projectPath, terminalId, text);
  };

  if (!terminalId) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)]" style={{ flexShrink: 0 }}>
        <button onClick={() => navigate("/sessions")} className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 -ml-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 1L3 7l6 6" /></svg>
        </button>
        <span className="text-[var(--text)] text-[13px] font-semibold truncate flex-1">
          {session?.label || session?.workspaceName || "Terminal"}
        </span>
        <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
      </div>

      {/* Terminal — explicit overflow container */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <TerminalView terminalId={terminalId} projectPath={projectPath} />
      </div>

      {/* Input bar — multi-line */}
      <div className="flex gap-2 px-4 pt-3 border-t border-[var(--border)] bg-[var(--surface)] input-bar" style={{ flexShrink: 0 }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Send to terminal..."
          rows={1}
          className="flex-1 bg-[var(--background)] border border-[var(--accent-dim)] px-3 text-[var(--text)] text-[13px] focus:outline-none resize-none"
          style={{
            height: 40,
            lineHeight: "20px",
            padding: "10px 12px",
            overflow: "hidden",
          }}
        />
        <button
          onTouchEnd={(e) => { e.preventDefault(); handleSend(); }}
          onClick={handleSend}
          disabled={!input.trim()}
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 self-end"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
