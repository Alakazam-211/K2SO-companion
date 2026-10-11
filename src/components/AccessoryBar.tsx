import { useEffect, useRef } from "react";
import {
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey,
} from "../lib/terminalKeys";
import type { LiveLocalEdit } from "../lib/liveInputText";

// T4 — the Direct-mode accessory key strip (Orca's default set, ported
// byte tables in lib/terminalKeys.ts): Esc/Tab/Shift+Tab, arrows,
// Ctrl chords, Backspace. A horizontal scrollable row of 44pt keys
// that sits directly above the iOS keyboard inside ChatSession's
// input bar — it rides the existing keyboard-height flow, so it never
// changes the terminal frame's row math beyond what K4 already does.
//
// Press model:
//   • repeatable keys (arrows, backspace) fire on POINTER DOWN and
//     hold-repeat: first repeat after 350ms, then every 80ms — the
//     interval IS the rate cap (≤12.5 keys/s), and pointerup/leave/
//     cancel (including the strip starting a horizontal scroll, which
//     cancels the pointer) stops it;
//   • chord keys (Esc, Ctrl+C…) fire on CLICK — the browser suppresses
//     click after a scroll gesture, so brushing past ^C while
//     scrolling the strip can never interrupt the PTY.
// pointerdown/mousedown are preventDefaulted so a key tap never steals
// focus from the hidden capture (the keyboard must stay up).

const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 80;

// Symbol glyphs (⌫ ↑ ↓ ← → and the ⇧/⌘ class — U+2190–21FF arrows,
// U+2300–23FF technical) render poorly in the app's mono font; wrap
// runs of them in `.key-symbol` (system font stack, the desktop K2
// idiom) while text labels (Esc, Tab, Ctrl+C) stay mono.
const KEY_SYMBOL_RUN = /([\u2190-\u21FF\u2300-\u23FF]+)/;

function renderKeyLabel(label: string) {
  const parts = label.split(KEY_SYMBOL_RUN);
  if (parts.length === 1) return label;
  return parts.map((part, i) =>
    KEY_SYMBOL_RUN.test(part) ? (
      <span key={i} className="key-symbol">
        {part}
      </span>
    ) : (
      part
    )
  );
}

interface Props {
  /** Deliver a key's bytes — ChatSession routes this through the
   *  capture pipeline so pending IME text flushes first and backspace
   *  local-edits pending text instead of sending \x7f. */
  onKey: (bytes: string, localEdit?: LiveLocalEdit) => void;
  /** `"zen"` = each key a frosted `.zen-glass` pill on the bare page
   *  background (no casing around the group), a Return key right after
   *  ⇧⏎, and a pinned hide-keyboard pill at the right end. Same press
   *  model; the default look is untouched. */
  variant?: "default" | "zen";
}

// Zen only: plain Return as a key, right after ⇧⏎. Same bytes the iOS
// keyboard's return sends through LiveInputCapture (\r, one CR).
export const ZEN_RETURN_KEY: TerminalAccessoryKey = {
  id: "return",
  label: "⏎",
  bytes: "\r",
  accessibilityLabel: "Return",
};

export const ZEN_ACCESSORY_KEYS: TerminalAccessoryKey[] = TERMINAL_ACCESSORY_KEYS.flatMap((k) =>
  k.id === "newline" ? [k, ZEN_RETURN_KEY] : [k]
);

/** Dismiss the iOS keyboard: blur whatever owns focus (the hidden
 *  live capture in Direct mode). */
export function hideKeyboard() {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

function HideKeyboardGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="3.5" width="19" height="11" rx="2" />
      <path d="M6 7h.01M9 7h.01M12 7h.01M15 7h.01M18 7h.01M6 10.5h.01M18 10.5h.01M9 10.5h6" />
      <path d="M9 18l3 3 3-3" />
    </svg>
  );
}

function localEditFor(k: TerminalAccessoryKey): LiveLocalEdit | undefined {
  if (k.id === "backspace") return "backspace";
  if (k.id === "delete") return "delete";
  return undefined;
}

export function AccessoryBar({ onKey, variant = "default" }: Props) {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  // At most one held key; both timers die on any stop.
  const repeatRef = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
  }>({ delay: null, interval: null });

  const stopRepeat = () => {
    const r = repeatRef.current;
    if (r.delay) clearTimeout(r.delay);
    if (r.interval) clearInterval(r.interval);
    r.delay = null;
    r.interval = null;
  };
  useEffect(() => stopRepeat, []);

  const startRepeat = (k: TerminalAccessoryKey) => {
    stopRepeat();
    onKeyRef.current(k.bytes, localEditFor(k));
    repeatRef.current.delay = setTimeout(() => {
      repeatRef.current.delay = null;
      repeatRef.current.interval = setInterval(() => {
        onKeyRef.current(k.bytes, localEditFor(k));
      }, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };

  const zen = variant === "zen";
  const keys = zen ? ZEN_ACCESSORY_KEYS : TERMINAL_ACCESSORY_KEYS;

  const toolbar = (
    <div
      data-k2="accessory-bar"
      role="toolbar"
      aria-label="Terminal keys"
      className={
        zen ? "flex gap-1.5 py-0.5 -ml-3 pl-3 pr-1 flex-1 min-w-0" : "flex gap-1.5 pb-2 -mx-4 px-4"
      }
      style={{
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        flexShrink: zen ? 1 : 0,
        scrollbarWidth: "none",
      }}
    >
      {keys.map((k) => (
        <button
          key={k.id}
          data-k2-key={k.id}
          aria-label={k.accessibilityLabel ?? k.label}
          onMouseDown={(e) => e.preventDefault()}
          onContextMenu={(e) => e.preventDefault()}
          {...(k.repeatable
            ? {
                onPointerDown: (e: React.PointerEvent) => {
                  e.preventDefault();
                  startRepeat(k);
                },
                onPointerUp: stopRepeat,
                onPointerLeave: stopRepeat,
                onPointerCancel: stopRepeat,
              }
            : {
                onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
                onClick: () => onKeyRef.current(k.bytes, localEditFor(k)),
              })}
          className={
            zen
              ? "zen-glass zen-glass-pill text-[var(--text)] text-[13px] shrink-0 active:opacity-60"
              : "border border-[var(--accent-dim)] bg-[var(--background)] text-[var(--text)] text-[12px] shrink-0"
          }
          style={{
            // Size-to-content: full chord labels (Ctrl+C) widen the key.
            // Classic: 44pt min is the touch-target floor. Zen: 32px pill.
            minWidth: zen ? 40 : 44,
            height: zen ? 32 : 44,
            padding: "0 12px",
            fontFamily: "inherit",
            touchAction: "pan-x", // horizontal strip scroll stays native
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          {renderKeyLabel(k.label)}
        </button>
      ))}
    </div>
  );

  if (!zen) return toolbar;

  // Zen: the key strip scrolls; the hide-keyboard pill is pinned at the
  // right end, outside the scroll, so it is always reachable. The row
  // itself has no fill, border or shadow — only the pills are glass.
  return (
    <div data-k2="accessory-row" className="flex items-center gap-1.5 pb-1">
      {toolbar}
      <button
        type="button"
        data-k2="hide-keyboard"
        aria-label="Hide keyboard"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        onClick={hideKeyboard}
        className="zen-glass zen-glass-pill text-[var(--text)] shrink-0 flex items-center justify-center active:opacity-60"
        style={{ width: 44, height: 32, padding: 0, userSelect: "none", WebkitUserSelect: "none" }}
      >
        <HideKeyboardGlyph />
      </button>
    </div>
  );
}
