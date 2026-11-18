// Who is typing (brief §2.9; desktop `HomeChatTyping.tsx`): a quiet
// "Alex is typing" / "Alex and 2 others are typing" with three breathing
// dots, hanging on the composer's top edge. It sits in the dock's
// zero-height row, out of the flow, so it never moves the box or the list;
// it fades in and out. One polite live region: a screen reader hears the
// names once, not every dot.

import { typingLine } from "../../api/homeChatHelpers";
import "./homeChat.css";

/** The line without its ellipsis (the dots draw it). `line` gives other
 *  words (the Thread's, threadTypingLine); Home chat's by default. */
export function typingWords(
  names: readonly string[],
  line: (names: readonly string[]) => string = typingLine
): string {
  return line(names).replace(/…$/, "");
}

export function HomeChatTyping({
  names,
  line = typingLine,
}: {
  names: readonly string[];
  /** The full line, ending "…" (drawn as the dots). Home chat's default. */
  line?: (names: readonly string[]) => string;
}) {
  const on = names.length > 0;
  return (
    <div
      aria-live="polite"
      data-testid="home-chat-typing"
      data-on={on ? "" : undefined}
      className="k2-hc-typing absolute flex items-center pointer-events-none text-[12px] leading-4 whitespace-nowrap"
      style={{
        left: 16,
        bottom: 2,
        maxWidth: "calc(100% - 32px)",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 9,
        background: "var(--color-bg)",
        color: "var(--color-text-muted)",
        opacity: on ? 1 : 0,
      }}
    >
      <span className="min-w-0 truncate" data-testid="home-chat-typing-words">
        {on ? typingWords(names, line) : ""}
      </span>
      {on ? (
        <span className="k2-hc-dots shrink-0" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      ) : null}
    </div>
  );
}
