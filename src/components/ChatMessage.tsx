// Shared thread body for Project chat + Feedback comments.
// Port of K2 `src/renderer/components/common/ChatMessage.tsx`:
// full-width attributed cards (not left/right bubbles) + GFM markdown.

import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import Markdown from "./Markdown";
import { authorTint } from "../lib/authorTint";
import { linkifyFileMentions } from "../zen/chatLinks";

/** One plugin list for every body: a new array each render would rebuild
 *  ReactMarkdown's processor for nothing. */
const REMARK_PLUGINS = [remarkGfm];

/** A message body. Memoized: the markdown is parsed again only when its
 *  text (or link handler) changes, not on every re-render of the list
 *  around it (typing, the keyboard, activity frames). Pass a stable
 *  `style` object to skip the re-render altogether. */
export const ChatMessageBody = memo(function ChatMessageBody({
  text,
  className = "",
  style,
  onFileLink,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
  onFileLink?: (ref: string) => void;
}) {
  const body = useMemo(
    () => (
      <Markdown remarkPlugins={REMARK_PLUGINS} onFileLink={onFileLink}>
        {linkifyFileMentions(text)}
      </Markdown>
    ),
    [text, onFileLink]
  );
  return (
    <div
      className={`markdown-content chat-markdown ${className}`.trim()}
      style={style}
    >
      {body}
    </div>
  );
});

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
      className="flex flex-col border"
      style={{
        background: tint.background,
        borderColor: tint.border,
        padding: "12px 16px 14px",
      }}
    >
      <div className="flex items-baseline gap-2 min-w-0" style={{ marginBottom: 8 }}>
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
      {footer ? <div style={{ marginTop: 8 }}>{footer}</div> : null}
    </div>
  );
}
