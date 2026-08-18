// Shared thread body for Project chat + Feedback comments.
// Port of K2 `src/renderer/components/common/ChatMessage.tsx`:
// full-width attributed cards (not left/right bubbles) + GFM markdown.

import type { CSSProperties, ReactNode } from "react";
import remarkGfm from "remark-gfm";
import Markdown from "./Markdown";
import { authorTint } from "../lib/authorTint";

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
  /** Stable key for the per-person wash (the stored author, not "You"). */
  tintKey,
}: {
  author: string;
  isOwner: boolean;
  timeLabel: string;
  body: string;
  footer?: ReactNode;
  tintKey?: string;
}) {
  const tint = authorTint(tintKey ?? author, isOwner);
  return (
    <div
      className="flex flex-col gap-1.5 px-4 py-3 border"
      style={{
        background: tint.background,
        borderColor: tint.border,
      }}
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className="text-[12px] font-semibold truncate"
          style={{ color: tint.name }}
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
