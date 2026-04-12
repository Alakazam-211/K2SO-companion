import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api/client";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";

export function ChatSession() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const activeProject = useWorkspacesStore((s) => s.activeProject());
  const projectPath = activeProject?.path || "";
  const [input, setInput] = useState("");

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
        <button onClick={() => navigate("/workspaces")} className="text-[var(--accent)] text-[13px]">←</button>
        <span className="text-[var(--text)] text-[13px] font-semibold truncate flex-1">
          {activeProject?.name || "Terminal"}
        </span>
        <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
      </div>

      {/* Terminal — explicit overflow container */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <TerminalView terminalId={terminalId} projectPath={projectPath} />
      </div>

      {/* Input bar — multi-line */}
      <div className="flex gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface)]" style={{ flexShrink: 0 }}>
        <textarea
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
          className="flex-1 bg-[var(--background)] border border-[var(--border)] px-3 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors resize-none"
          style={{ maxHeight: 100, height: 40, lineHeight: "38px", overflow: "hidden" }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.style.lineHeight = "20px";
            el.style.paddingTop = "9px";
            el.style.height = "auto";
            el.style.height = Math.min(Math.max(el.scrollHeight, 40), 100) + "px";
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center disabled:border-[var(--border)] disabled:text-[var(--text-muted)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-all shrink-0 self-end"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
