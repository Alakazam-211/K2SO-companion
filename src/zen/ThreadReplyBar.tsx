import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { COMPOSER_DRAWER_INSET_PX } from "./GlassComposer";
import { ReplyIcon } from "./icons";
import { JUMP_PILL_FILL } from "./JumpPill";
import { threadReplyFirstLine, threadReplyQuote, type ThreadReplyTarget } from "./threadReply";

// The Thread's reply bar: what the next send replies to, standing on the
// composer — K2 desktop's (570a5a2ea0, ThreadReplyBar.tsx; the owner
// 2026-11-15: the old chip was "wider than the activity ear and …
// completely transparent").
//
// - Where: the last row above the field, on the activity ear's own edges
//   (COMPOSER_DRAWER_INSET_PX in from the field: the phone's ear inset, as
//   the desktop's 14px is its ear's), THREAD_REPLY_BAR_GAP over the ear
//   (the Jump to bottom pill's gap). In the bar's flow (the composer keeps
//   the ear's room under it), so it comes down with the ear.
// - What: "Replying to <name>:" (or "…part of…"), the quoted message's
//   first line in whole words, then "…", and ×.
// - Glass: the Jump to bottom pill's (JumpPill: zen-glass, its scrim, rim
//   and ink), every word in the ink. Reduced transparency: the solid tile
//   (index.css `.zen-reply-bar`).
// - ×: 24px to the eye; its hit area reaches 44 × 44 (negative margins, so
//   the bar stays 32px tall).
//
// Home chat keeps its own chip (HomeChatView), as the desktop's does.

/** Space (px) between the bar and the ear (or the field) under it: the pill's. */
export const THREAD_REPLY_BAR_GAP = 8;
/** The bar's height and side padding (px), the Jump to bottom pill's. */
export const THREAD_REPLY_BAR_H = 32;
const PAD_X = 14;
/** × to the eye, and its tap target (px). */
export const REPLY_CANCEL_PX = 24;
export const REPLY_CANCEL_HIT_PX = 44;

/** `line` cut to whole words that fit `room` px (measured by `width`), then
 *  "…"; just "…" when not even the first word fits. `room` 0: not measured
 *  yet, the whole line. (The desktop's fitReplyWords.) */
export function fitReplyWords(line: string, room: number, width: (s: string) => number): string {
  if (room <= 0 || width(line) <= room) return line;
  const words = line.split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n > 0; n--) {
    const s = `${words.slice(0, n).join(" ").replace(/[\s,;:.–—-]+$/, "")}…`;
    if (width(s) <= room) return s;
  }
  return "…";
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Text width in `el`'s own font (a canvas; null where there is none). */
function textWidth(el: HTMLElement): ((s: string) => number) | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext?.("2d") ?? null;
    } catch {
      measureCtx = null;
    }
  }
  const ctx = measureCtx;
  if (!ctx) return null;
  const cs = getComputedStyle(el);
  ctx.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return (s) => ctx.measureText(s).width;
}

/** The first line, fitted to its slot in whole words (refitted when the
 *  slot changes size). */
function useFittedLine(line: string): { ref: RefObject<HTMLSpanElement | null>; text: string } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setRoom(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const el = ref.current;
  const width = el && room > 0 ? textWidth(el) : null;
  return { ref, text: width ? fitReplyWords(line, room, width) : line };
}

export function ThreadReplyBar({ target, onCancel }: { target: ThreadReplyTarget; onCancel: () => void }) {
  const line = threadReplyFirstLine(threadReplyQuote(target));
  const name = target.from.trim().replace(/\s+/g, " ") || "someone";
  const who = `${target.part ? "Replying to part of" : "Replying to"} ${name}`;
  const fitted = useFittedLine(line);
  const hitX = (REPLY_CANCEL_HIT_PX - REPLY_CANCEL_PX) / 2;
  const hitY = (REPLY_CANCEL_HIT_PX - THREAD_REPLY_BAR_H) / 2;
  return (
    <div
      data-testid="reply-row"
      className="min-w-0"
      style={{ margin: `0 ${COMPOSER_DRAWER_INSET_PX}px ${THREAD_REPLY_BAR_GAP}px` }}
    >
      <div
        data-testid="reply-chip"
        data-reply-part={target.part ? "" : undefined}
        className="zen-glass zen-glass-pill zen-jump-pill zen-reply-bar flex items-center gap-1.5 min-w-0 text-[13px] whitespace-nowrap"
        role="note"
        aria-label={`${who}: ${line}`}
        style={{
          minHeight: THREAD_REPLY_BAR_H,
          padding: `0 4px 0 ${PAD_X}px`,
          ...JUMP_PILL_FILL,
          lineHeight: "16px",
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }}
      >
        <ReplyIcon size={14} strokeWidth={1.75} className="shrink-0" />
        <span data-reply-chip-who="" className="min-w-0 truncate font-semibold" style={{ flex: "0 1 auto", maxWidth: "55%" }}>
          {who}:
        </span>
        <span data-reply-chip-text="" ref={fitted.ref} className="min-w-0 overflow-hidden" style={{ flex: "1 1 0" }}>
          {fitted.text}
        </span>
        <button
          type="button"
          aria-label="Cancel the reply"
          data-testid="reply-chip-cancel"
          className="relative shrink-0 flex items-center justify-center bg-transparent border-0 p-0 rounded-full"
          style={{
            width: REPLY_CANCEL_HIT_PX,
            height: REPLY_CANCEL_HIT_PX,
            margin: `-${hitY}px -${hitX}px`,
            color: "inherit",
            fontSize: 15,
            lineHeight: 1,
          }}
          // Keep the keyboard up: a blur would drop the composer mid-tap.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          <span
            aria-hidden="true"
            className="zen-reply-cancel-x flex items-center justify-center rounded-full"
            style={{ width: REPLY_CANCEL_PX, height: REPLY_CANCEL_PX }}
          >
            ×
          </span>
        </button>
      </div>
    </div>
  );
}
