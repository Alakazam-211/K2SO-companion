interface Props {
  text: string;
  isUser: boolean;
}

export function ChatBubble({ text, isUser }: Props) {
  return (
    <div
      className={`max-w-[85%] px-3 py-2 mb-1 whitespace-pre-wrap text-[11px] leading-5 ${
        isUser
          ? "self-end bg-[var(--accent-dim)] text-[var(--text)] border border-[var(--accent)]/30"
          : "self-start bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]"
      }`}
    >
      {text}
    </div>
  );
}
