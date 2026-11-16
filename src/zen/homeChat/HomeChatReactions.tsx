// Reactions on a Home chat bubble (brief §2.9; desktop
// `HomeChatReactions.tsx`, adapted for touch):
//   - chips under the bubble: the emoji and its count, a ring on yours; a
//     tap toggles yours; a long press names who reacted (a tip over the
//     chip, read from `reactors`);
//   - the picker is the message hold menu (K2 Design): the six quick
//     emoji across its top (`QuickReactionRow`), then Reply, Copy, and
//     "More emoji…", which opens `EmojiSheet` (a search over the built-in
//     Unicode list). Unicode only.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HomeChatReaction } from "../../api/homeChatPure";
import { useBackHandler } from "../../lib/androidBack";
import { useViewport } from "../../lib/useViewportHeight";
import { QUICK_REACTIONS, reactionTipText, searchEmoji } from "./homeChatModel";
import "./homeChat.css";

/** A long press on a chip this long names who reacted. */
export const CHIP_HOLD_MS = 450;
/** The tip stays this long after it opened. */
const TIP_MS = 2600;

function ReactionTip({ anchor, text }: { anchor: DOMRect; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth || 393;
    let top = anchor.top - h - 6;
    if (top < 8) top = anchor.bottom + 6;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - w / 2, vw - w - 8));
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [anchor, text]);
  return createPortal(
    <div
      ref={ref}
      role="status"
      data-testid="home-chat-reaction-tip"
      className="fixed zen-glass text-[12px] leading-snug"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxWidth: 280,
        padding: "5px 10px",
        borderRadius: 10,
        zIndex: 60,
        pointerEvents: "none",
        color: "var(--color-text-primary)",
      }}
    >
      {text}
    </div>,
    document.body
  );
}

function Chip({
  r,
  disabled,
  onToggle,
  whoFor,
}: {
  r: HomeChatReaction;
  disabled: boolean;
  onToggle: (emoji: string) => void;
  whoFor: (emoji: string) => Promise<string[] | null>;
}) {
  const [tip, setTip] = useState<{ rect: DOMRect; names: string[] | undefined } | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const held = useRef(false);
  useEffect(() => {
    if (!tip) return;
    const t = setTimeout(() => setTip(null), TIP_MS);
    return () => clearTimeout(t);
  }, [tip]);
  useEffect(() => () => {
    if (hold.current) clearTimeout(hold.current.timer);
  }, []);
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const label = `${r.emoji} ${r.count}${r.me ? ", yours" : ""}`;
  return (
    <>
      <button
        type="button"
        className="k2-hc-chip"
        data-testid="home-chat-reaction"
        data-emoji={r.emoji}
        data-mine={r.me ? "" : undefined}
        aria-pressed={r.me}
        aria-label={`${label}. Tap to ${r.me ? "remove yours" : "add yours"}; hold to see who reacted`}
        disabled={disabled}
        style={disabled ? { opacity: 0.8 } : undefined}
        onPointerDown={(e) => {
          held.current = false;
          cancel();
          const el = e.currentTarget;
          hold.current = {
            x: e.clientX,
            y: e.clientY,
            timer: setTimeout(() => {
              hold.current = null;
              held.current = true;
              const rect = el.getBoundingClientRect();
              setTip({ rect, names: undefined });
              void whoFor(r.emoji).then((names) =>
                setTip((cur) => (cur ? { rect: cur.rect, names: names ?? [] } : cur))
              );
            }, CHIP_HOLD_MS),
          };
        }}
        onPointerMove={(e) => {
          const h = hold.current;
          if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          // The long press named who reacted: its release is no toggle.
          if (held.current) {
            held.current = false;
            return;
          }
          if (!disabled) onToggle(r.emoji);
        }}
      >
        <span aria-hidden>{r.emoji}</span>
        <span aria-hidden>{r.count}</span>
      </button>
      {tip ? <ReactionTip anchor={tip.rect} text={reactionTipText(tip.names, r.emoji)} /> : null}
    </>
  );
}

/** The chips under one bubble (none: nothing). */
export function ReactionChips({
  reactions,
  mine,
  disabled = false,
  onToggle,
  whoFor,
}: {
  reactions: readonly HomeChatReaction[];
  /** Under your bubble: the chips line up on the right. */
  mine: boolean;
  disabled?: boolean;
  onToggle: (emoji: string) => void;
  whoFor: (emoji: string) => Promise<string[] | null>;
}) {
  if (reactions.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap gap-1 mt-1 px-0.5 ${mine ? "justify-end" : "justify-start"}`}
      data-testid="home-chat-reactions"
      data-no-dismiss=""
    >
      {reactions.map((r) => (
        <Chip key={r.emoji} r={r} disabled={disabled} onToggle={onToggle} whoFor={whoFor} />
      ))}
    </div>
  );
}

/** The hold menu's top row: the six quick emoji (a ring on yours). */
export function QuickReactionRow({
  mine,
  onPick,
}: {
  /** Emoji you already reacted with on this message. */
  mine: ReadonlySet<string>;
  onPick: (emoji: string) => void;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: "2px 2px 6px", gap: 2 }}
      role="group"
      aria-label="React"
      data-testid="home-chat-quick-reactions"
    >
      {QUICK_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitem"
          aria-label={`React ${e}`}
          aria-pressed={mine.has(e)}
          data-testid="home-chat-quick-reaction"
          data-emoji={e}
          className="flex items-center justify-center bg-transparent border-0 p-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            fontSize: 21,
            lineHeight: 1,
            background: mine.has(e) ? "var(--color-wash-3)" : "transparent",
            boxShadow: mine.has(e) ? "0 0 0 1.5px var(--color-accent)" : undefined,
          }}
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** Its height (px), for the menu's placement. */
export const QUICK_ROW_PX = 40;

/** "More emoji…": a bottom sheet with a search over the built-in list. */
export function EmojiSheet({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useBackHandler(true, onClose);
  const found = searchEmoji(q);
  // Above the keyboard while the search field has it.
  const vp = useViewport();
  return createPortal(
    <div
      className="fixed left-0 right-0 flex items-end justify-center"
      style={{ top: vp.offsetTop, height: vp.height, background: "var(--color-scrim)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="home-chat-emoji-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="React with an emoji"
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "12px 12px max(12px, var(--safe-bottom))",
          gap: 10,
          maxHeight: "70%",
          color: "var(--color-text-primary)",
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search emoji"
            aria-label="Search emoji"
            data-testid="home-chat-emoji-search"
            className="flex-1 min-w-0 text-[16px] outline-none"
            style={{
              height: 36,
              padding: "0 12px",
              borderRadius: 10,
              border: 0,
              background: "var(--color-bg-elevated)",
              color: "var(--color-text-primary)",
            }}
          />
          <button
            type="button"
            className="text-[16px] bg-transparent border-0 shrink-0"
            style={{ color: "var(--color-accent-text)", padding: "0 4px" }}
            onClick={onClose}
            data-testid="home-chat-emoji-cancel"
          >
            Cancel
          </button>
        </div>
        <div className="overflow-y-auto min-h-0" style={{ WebkitOverflowScrolling: "touch" }}>
          {found.length === 0 ? (
            <p className="py-6 text-center text-[14px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-emoji-none">
              No emoji match “{q.trim()}”.
            </p>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))", gap: 2 }}>
              {found.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`React ${e}`}
                  data-testid="home-chat-emoji"
                  data-emoji={e}
                  className="flex items-center justify-center bg-transparent border-0 p-0"
                  style={{ height: 44, fontSize: 26, lineHeight: 1, borderRadius: 10 }}
                  onClick={() => onPick(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
