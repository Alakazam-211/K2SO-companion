import { useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./sendFly";
import { DRAWER_EASE_GROW, DRAWER_EASE_IN, DRAWER_EASE_OUT, DRAWER_MS } from "./ThreadWorkingStrip";

// The Thread's pill over the composer (owner 2026-11-11, with K2 desktop):
// "Jump to bottom" whenever the reader has scrolled up; when a message
// arrives below, or their own send lands while they're up, the words become
// "New message" ("N new messages" from two, as K2 desktop) or "Sent", and
// the pill's width glides to fit them.

export type JumpPillWords = "jump" | "message" | "sent";

export const JUMP_PILL_TEXT: Record<JumpPillWords, string> = {
  jump: "Jump to bottom",
  message: "New message",
  sent: "Sent",
};

const PAD_X = 14;
/** The pill's fill, as K2 desktop's (from K2 Design 2026-11-16): on dark,
 *  zen-glass's 10% white tint over a 60% dark layer. Over your own blue
 *  bubble the plain tint left white text about 3:1 (about 1:1 over a white
 *  image); with the layer it's about 9:1, and it still reads as the same
 *  glass on the dark canvas. On light (Veil): the 72% white Frost, no dark
 *  layer, dark words and a 45% dark rim. The values are index.css's
 *  `--jump-pill-*` (per scheme); the fallbacks here are dark's. The blur
 *  stays zen-glass's. */
export const JUMP_PILL_DARK = {
  tint: "rgba(255, 255, 255, 0.1)",
  scrim: "rgba(0, 0, 0, 0.6)",
} as const;
const TINT = `var(--jump-pill-tint, ${JUMP_PILL_DARK.tint})`;
export const JUMP_PILL_FILL = {
  backgroundImage: `linear-gradient(${TINT}, ${TINT})`,
  backgroundColor: `var(--jump-pill-scrim, ${JUMP_PILL_DARK.scrim})`,
  color: "var(--jump-pill-ink, #fff)",
} as const;
const WIDTH_MS = 220;

/** The pill's gap (px) over what it stands on: the composer's top (the
 *  field, or the rows over it: reply bar, chips, label), or the activity
 *  ear while it is out. */
export const JUMP_PILL_GAP_PX = 8;

/** Where the pill floats (owner 2026-11-17: "If there is no activity bar
 *  the jump to bottom button should settle just above the text area rather
 *  than above where the activity ear would be if it were open. Use
 *  animation to move it up/down when the activity area opens/closes"; K2
 *  desktop's threadDock does the same). Its row is zero-height at the
 *  composer bar's top, inside the keyboard-following dock:
 *   - `bottom`: px up from the bar's top to the pill's foot with no ear:
 *     the gap over the composer's top, which sits `topGap` px into the bar
 *     (its top padding, the empty label's margin). Negative: the pill
 *     reaches into the bar's empty top padding.
 *   - `lift`: the ear's part, played as a translate so the pill rides the
 *     ear's own slide. With rows over the field the bar keeps the ear's room
 *     under them instead (drawerRoom): they, and the pill over them, stand
 *     on it in the layout, so the lift is 0. */
export function jumpPillPlace(
  topGap: number,
  earSpace: number,
  rowsAboveField: boolean
): { bottom: number; lift: number } {
  const gap = Number.isFinite(topGap) && topGap > 0 ? topGap : 0;
  const ear = !rowsAboveField && Number.isFinite(earSpace) && earSpace > 0 ? Math.ceil(earSpace) : 0;
  return { bottom: JUMP_PILL_GAP_PX - gap, lift: ear };
}

/** The pill's ride with the ear: the lift it shows and the transition that
 *  took it there. */
export type JumpPillRide = { lift: number; rows: boolean; transition: string };

/** The next ride from `prev` (the same object when nothing moved). The
 *  ear sliding out: its slide-in curve; folding away: its slide-out curve;
 *  growing or shrinking on a tap: the tile's height curve; all DRAWER_MS.
 *  Rows over the field coming or going move the composer in one layout
 *  (the ear's room with them): the pill jumps with it. Reduced motion:
 *  it jumps. */
export function jumpPillRide(
  prev: JumpPillRide,
  lift: number,
  rows: boolean,
  reduced: boolean
): JumpPillRide {
  if (prev.lift === lift && prev.rows === rows) return prev;
  let transition = "none";
  if (!reduced && prev.rows === rows) {
    const ease = prev.lift <= 0 ? DRAWER_EASE_IN : lift <= 0 ? DRAWER_EASE_OUT : DRAWER_EASE_GROW;
    transition = `transform ${DRAWER_MS}ms ${ease}`;
  }
  return { lift, rows, transition };
}

/** The pill's words: "N new messages" once two or more arrived. */
export function jumpPillText(words: JumpPillWords, count = 0): string {
  return words === "message" && count >= 2 ? `${count} new messages` : JUMP_PILL_TEXT[words];
}

export function JumpPill({
  words,
  count = 0,
  leaving,
  onJump,
}: {
  words: JumpPillWords;
  /** Messages that arrived below while scrolled up. */
  count?: number;
  /** Tapped: fading out. */
  leaving: boolean;
  onJump: () => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const text = jumpPillText(words, count);
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
      className="pointer-events-auto zen-glass zen-glass-pill zen-jump-pill zen-pill-in text-[13px] flex items-center justify-center"
      style={{
        minHeight: 32,
        padding: 0,
        ...JUMP_PILL_FILL,
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
