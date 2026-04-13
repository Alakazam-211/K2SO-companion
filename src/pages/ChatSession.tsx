import { useState, useRef, useLayoutEffect, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api/client";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";

// @ts-expect-error Vite injects import.meta.env
const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

export function ChatSession() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const session = useWorkspacesStore((s) =>
    s.allSessions.find((sess) => sess.terminalId === terminalId)
  );
  const projectPath = session?.cwd || "";
  const [input, setInput] = useState("");
  const [containerHeight, setContainerHeight] = useState(window.innerHeight);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalWrapperRef = useRef<HTMLDivElement>(null);
  const [debugInfo, setDebugInfo] = useState("");

  // Manual touch-scroll: WKWebView with scrollEnabled=false sometimes blocks
  // CSS overflow:auto scrolling. We handle it manually via touchmove.
  useEffect(() => {
    const wrapper = terminalWrapperRef.current;
    if (!wrapper) return;

    let startY = 0;
    let scrollEl: HTMLElement | null = null;

    const findScrollEl = () => {
      if (!scrollEl) {
        // Find the TerminalView's scroll container (overflow: auto), not the wrapper (overflow: hidden)
        const candidates = wrapper.querySelectorAll('div');
        for (const el of candidates) {
          if (el.style.overflow === 'auto' && el.scrollHeight > el.clientHeight) {
            scrollEl = el;
            break;
          }
        }
        // Fallback: first element with overflow auto
        if (!scrollEl) {
          for (const el of candidates) {
            if (el.style.overflow === 'auto') {
              scrollEl = el;
              break;
            }
          }
        }
      }
      return scrollEl;
    };

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      findScrollEl();
    };

    const onTouchMove = (e: TouchEvent) => {
      const el = findScrollEl();
      if (!el) return;
      const deltaY = startY - e.touches[0].clientY;
      startY = e.touches[0].clientY;
      el.scrollTop += deltaY;
      // Dispatch scroll event so TerminalView's auto-scroll logic updates
      el.dispatchEvent(new Event('scroll'));
      e.preventDefault();
    };

    wrapper.addEventListener("touchstart", onTouchStart, { passive: true });
    wrapper.addEventListener("touchmove", onTouchMove, { passive: false });

    const updateDebug = () => {
      const el = findScrollEl();
      setDebugInfo(`w=${wrapper.offsetHeight} s=${el?.clientHeight ?? -1}/${el?.scrollHeight ?? -1} top=${el?.scrollTop?.toFixed(0) ?? -1}`);
    };
    requestAnimationFrame(updateDebug);
    const t = setTimeout(updateDebug, 500);

    return () => {
      clearTimeout(t);
      wrapper.removeEventListener("touchstart", onTouchStart);
      wrapper.removeEventListener("touchmove", onTouchMove);
      scrollEl = null;
    };
  }, [containerHeight]);

  // Listen for viewport resize from native JS injection + visualViewport
  useEffect(() => {
    const root = document.getElementById("root");
    const rootStyle = root ? getComputedStyle(root) : null;
    const safeAreaTop = parseInt(rootStyle?.paddingTop || '0', 10) || 0;
    const fullHeight = window.innerHeight;

    const update = () => {
      const vv = window.visualViewport;
      const vvHeight = vv ? vv.height : window.innerHeight;
      if (vvHeight < fullHeight - 100) {
        // Keyboard open — subtract top safe area only (keyboard covers bottom)
        setContainerHeight(vvHeight - safeAreaTop);
      } else {
        // Keyboard closed — need room for home indicator + input bar padding
        setContainerHeight(fullHeight - safeAreaTop - 34);
      }
      // Prevent iOS from scrolling the page during keyboard animation
      window.scrollTo(0, 0);
    };

    const onCustom = (e: Event) => {
      const h = (e as CustomEvent).detail?.height;
      if (h && h < fullHeight - 100) {
        setContainerHeight(h - safeAreaTop);
      } else {
        setContainerHeight(fullHeight - safeAreaTop - 34);
      }
    };

    // Set initial height accounting for safe area
    update();

    window.addEventListener("k2-viewport-resize", onCustom);
    window.visualViewport?.addEventListener("resize", update);

    // Poll during focus transitions
    const onFocusIn = () => { setTimeout(update, 100); setTimeout(update, 300); setTimeout(update, 500); };
    const onFocusOut = () => { setTimeout(update, 100); setTimeout(update, 300); };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      window.removeEventListener("k2-viewport-resize", onCustom);
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

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
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: containerHeight,
      overflow: "hidden",
    }}>
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

      {DEV_MODE && (
        <div style={{ flexShrink: 0, color: "#22d3ee", fontSize: 9, padding: "2px 8px", opacity: 0.7 }}>
          h={containerHeight.toFixed(0)} | vv={window.visualViewport?.height?.toFixed(0)} | {debugInfo}
        </div>
      )}

      {/* Terminal — only scrollable area */}
      <div ref={terminalWrapperRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
        <TerminalView terminalId={terminalId} projectPath={projectPath} />
      </div>

      {/* Input bar */}
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
