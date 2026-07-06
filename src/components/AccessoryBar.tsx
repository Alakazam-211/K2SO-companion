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
}

function localEditFor(k: TerminalAccessoryKey): LiveLocalEdit | undefined {
  if (k.id === "backspace") return "backspace";
  if (k.id === "delete") return "delete";
  return undefined;
}

export function AccessoryBar({ onKey }: Props) {
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

  return (
    <div
      data-k2="accessory-bar"
      role="toolbar"
      aria-label="Terminal keys"
      className="flex gap-1.5 pb-2 -mx-4 px-4"
      style={{
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        flexShrink: 0,
        scrollbarWidth: "none",
      }}
    >
      {TERMINAL_ACCESSORY_KEYS.map((k) => (
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
          className="border border-[var(--accent-dim)] bg-[var(--background)] text-[var(--text)] text-[12px] shrink-0"
          style={{
            // Size-to-content: full chord labels (Ctrl+C) widen the key;
            // 44pt min stays the touch-target floor.
            minWidth: 44,
            height: 44,
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
}
