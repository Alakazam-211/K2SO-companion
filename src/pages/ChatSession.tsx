import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import { ChatBubble } from "../components/ChatBubble";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
}

function rewriteLocalhostUrls(text: string, serverUrl: string): string {
  return text.replace(
    /https?:\/\/localhost:(\d+)(\/[^\s)}\]]*)?/g,
    (_match, port, path) => `${serverUrl.replace(/\/$/, "")}/_preview/${port}${path || "/"}`
  );
}

export function ChatSession() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const { serverUrl } = useAuthStore();
  const activeProject = useWorkspacesStore((s) => s.activeProject());
  const projectPath = activeProject?.path || "";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [lastLineCount, setLastLineCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const addAgentMessage = useCallback((text: string) => {
    const rewritten = rewriteLocalhostUrls(text, serverUrl);
    setMessages((prev) => [...prev, { id: `a-${Date.now()}`, text: rewritten, isUser: false }]);
  }, [serverUrl]);

  const loadBuffer = useCallback(async () => {
    if (!terminalId || !projectPath) return;
    const r = await api.readTerminal(projectPath, terminalId, 100);
    if (r.ok && r.data?.lines) {
      const lines = r.data.lines;
      if (lines.length > lastLineCount) {
        const text = lines.slice(lastLineCount).join("\n").trim();
        if (text) addAgentMessage(text);
        setLastLineCount(lines.length);
      }
    }
  }, [terminalId, lastLineCount, projectPath, addAgentMessage]);

  useEffect(() => {
    loadBuffer();
    if (terminalId) {
      ws.subscribeTerminal(terminalId);
      const unsub = ws.on("terminal:output", (event) => {
        const p = event.payload as { terminal_id: string; new_lines: string[] };
        if (p.terminal_id === terminalId && p.new_lines.length) {
          const text = p.new_lines.join("\n").trim();
          if (text) addAgentMessage(text);
        }
      });
      return () => { unsub(); ws.unsubscribeTerminal(terminalId); };
    }
  }, [terminalId]);

  useEffect(() => {
    if (!ws.isConnected) {
      const iv = setInterval(loadBuffer, 3000);
      return () => clearInterval(iv);
    }
  }, [loadBuffer]);

  useEffect(scrollToBottom, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !terminalId || !projectPath) return;
    setInput("");
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, text, isUser: true }]);
    await api.writeTerminal(projectPath, terminalId, text);
    setTimeout(loadBuffer, 1000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <button onClick={() => navigate("/workspaces")} className="text-[var(--accent)] text-[13px]">←</button>
        <span className="text-[var(--text)] text-[13px] font-semibold">Agent Chat</span>
        <div className="ml-auto w-2 h-2 rounded-full bg-[var(--success)]" />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 flex flex-col">
        {messages.length === 0 ? (
          <p className="text-[var(--text-muted)] text-[11px] text-center my-auto">Loading terminal output...</p>
        ) : (
          messages.map((m) => <ChatBubble key={m.id} text={m.text} isUser={m.isUser} />)
        )}
      </div>

      <div className="flex gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface)] shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Send a message to the agent..."
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
