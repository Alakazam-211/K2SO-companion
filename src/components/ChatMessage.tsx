// Shared thread body for Project chat + Feedback comments.
// Port of K2 `src/renderer/components/common/ChatMessage.tsx`:
// full-width attributed cards (not left/right bubbles) + GFM markdown.

import type { CSSProperties, ReactNode } from "react";
import remarkGfm from "remark-gfm";
import Markdown from "./Markdown";

export function ChatMessageBody({
  text,
  className = "",
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`markdown-content chat-markdown ${className}`.trim()}
      style={style}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

export function ChatMessage({
  author,
  isOwner,
  timeLabel,
  body,
  footer,
}: {
  author: string;
  isOwner: boolean;
  timeLabel: string;
  body: string;
  footer?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-1 px-3 py-2 ${
        isOwner
          ? "bg-[var(--accent-dim)]/15"
          : "bg-[var(--surface)]"
      }`}
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className={`text-[12px] font-semibold truncate ${
            isOwner
              ? "text-[var(--accent)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          {author}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
          {timeLabel}
        </span>
      </div>
      <ChatMessageBody text={body} className="text-[var(--text)]" />
      {footer}
    </div>
  );
}
