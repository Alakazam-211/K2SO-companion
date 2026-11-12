import { useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./sendFly";

// The Thread's pill over the composer (Rosson 2026-11-11, with K2 desktop):
// "Jump to bottom" whenever the reader has scrolled up; when a message
// arrives below, or their own send lands while they're up, the words become
// "New message" or "Sent", and the pill's width glides to fit them.

export type JumpPillWords = "jump" | "message" | "sent";

export const JUMP_PILL_TEXT: Record<JumpPillWords, string> = {
  jump: "Jump to bottom",
  message: "New message",
  sent: "Sent",
};

const PAD_X = 14;
const WIDTH_MS = 220;

export function JumpPill({
  words,
  leaving,
  onJump,
}: {
  words: JumpPillWords;
  /** Tapped: fading out. */
  leaving: boolean;
  onJump: () => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const text = JUMP_PILL_TEXT[words];
  // The label's own width sets the pill's, so a change of words animates
  // the pill (CSS can't transition to `auto`).
  useLayoutEffect(() => {
    const w = labelRef.current?.offsetWidth ?? 0;
    if (w > 0) setWidth(Math.ceil(w) + 2 * PAD_X);
  }, [text]);
  const still = prefersReducedMotion();
  return (
    <button
      type="button"
      data-testid="thread-new-message"
      data-words={words}
      className="pointer-events-auto zen-glass zen-glass-pill zen-pill-in text-[13px] flex items-center justify-center"
      style={{
        minHeight: 32,
        padding: 0,
        color: "#fff",
        overflow: "hidden",
        whiteSpace: "nowrap",
        ...(width !== null ? { width } : { padding: `0 ${PAD_X}px` }),
        transition: still
          ? undefined
          : `width ${WIDTH_MS}ms cubic-bezier(0.22, 1, 0.36, 1)${leaving ? ", opacity 140ms ease-out" : ""}`,
        ...(leaving ? { opacity: 0, pointerEvents: "none" } : null),
      }}
      data-leaving={leaving ? "true" : undefined}
      // Keep focus in the textarea so the iOS keyboard stays up: a blur
      // drops the keyboard, the pill moves with the composer, and the tap
      // misses it (send button pattern).
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onJump}
    >
      <span ref={labelRef} style={{ display: "inline-block", flex: "none" }}>
        {text} <span aria-hidden="true">↓</span>
      </span>
    </button>
  );
}
