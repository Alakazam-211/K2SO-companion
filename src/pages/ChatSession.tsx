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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <button onClick={() => navigate("/workspaces")} className="text-[var(--accent)] text-[13px]">←</button>
        <span className="text-[var(--text)] text-[13px] font-semibold truncate flex-1">
          {activeProject?.name || "Terminal"}
        </span>
        <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
      </div>

      {/* Terminal */}
      <TerminalView terminalId={terminalId} projectPath={projectPath} />

      {/* Input bar */}
      <div className="flex gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface)] shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Send to terminal..."
          className="flex-1 bg-[var(--background)] border border-[var(--border)] px-3 py-2.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center disabled:border-[var(--border)] disabled:text-[var(--text-muted)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-all shrink-0"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
