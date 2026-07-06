import { useEffect, useMemo, useRef } from "react";
import {
  LiveTextCommitPipeline,
  type LiveLocalEdit,
} from "../lib/liveInputText";
import { getLiveSpecialKeyBytes } from "../lib/terminalKeys";

// T4 — the Direct-mode hidden capture: an invisible 1px text input that
// turns the iOS keyboard into LIVE PTY keystrokes. It never shows its
// own text — every commit goes straight to the terminal (whose own
// cursor is the echo) and the field is cleared. All text flows through
// lib/liveInputText.ts (composition-aware IME handling, smart-dash
// reversal, flush-before-control ordering); specials flow through
// keydown (Enter → \r exactly ONCE — keydown is preventDefaulted so no
// input event follows; Backspace → \x7f only when nothing is pending
// and no IME session owns it; Tab → \t; arrows/Esc/etc. for hardware
// keyboards via lib/terminalKeys.ts, which deliberately excludes Enter).
//
// The input sits IN-FLOW near the bottom of the input bar (opacity 0,
// 1×1px) — absolute-positioning it off-screen is what makes iOS
// scroll-jump the page to the focused field.

interface Props {
  /** Deliver bytes to the PTY (ChatSession wires the grid-WS seam). */
  send: (bytes: string) => void;
  /** Populated with a focus() trigger — tapping the terminal in Direct
   *  mode opens the keyboard through this (never auto-focused: Orca's
   *  no-auto-open rule). Cleared to null on unmount. */
  focusRef?: { current: (() => void) | null };
  /** Populated with the pipeline's control-byte entry so the accessory
   *  bar's chords share the flush-pending-first ordering. Cleared to
   *  null on unmount. */
  sendKeyRef?: { current: ((bytes: string, localEdit?: LiveLocalEdit) => void) | null };
}

export function LiveInputCapture({ send, focusRef, sendKeyRef }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  // One pipeline per mount; the sink reads through refs so the latest
  // send prop and the live DOM node are always the targets.
  const pipeline = useMemo(
    () =>
      new LiveTextCommitPipeline({
        sendBytes: (bytes) => sendRef.current(bytes),
        setFieldValue: (value) => {
          if (inputRef.current) inputRef.current.value = value;
        },
      }),
    []
  );

  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => inputRef.current?.focus({ preventScroll: true });
    }
    if (sendKeyRef) {
      sendKeyRef.current = (bytes, localEdit) => pipeline.controlBytes(bytes, localEdit);
    }
    return () => {
      if (focusRef) focusRef.current = null;
      if (sendKeyRef) sendKeyRef.current = null;
      pipeline.dispose();
    };
  }, [focusRef, sendKeyRef, pipeline]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 229 / isComposing = the IME owns this key (including its Enter-
    // to-confirm and backspace-inside-composition) — never intercept.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault(); // no input event follows → \r exactly once
      pipeline.controlBytes("\r");
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      pipeline.controlBytes("\x7f", "backspace");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      pipeline.controlBytes("\t");
      return;
    }
    // Hardware-keyboard specials (arrows, Esc, Home/End, F-keys…).
    const special = getLiveSpecialKeyBytes(e.key);
    if (special) {
      e.preventDefault();
      pipeline.controlBytes(special, e.key === "Delete" ? "delete" : undefined);
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      data-k2="live-capture"
      aria-label="Terminal keyboard input"
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="enter"
      onKeyDown={onKeyDown}
      onInput={(e) => pipeline.fieldInput(e.currentTarget.value)}
      onCompositionStart={() => pipeline.compositionStart()}
      onCompositionEnd={(e) =>
        pipeline.compositionEnd(e.data ?? e.currentTarget.value)
      }
      style={{
        // In-flow + visually nothing: opacity 0 (not display:none — iOS
        // won't keyboard a hidden field), 1×1px, no caret, no highlight.
        opacity: 0,
        width: 1,
        height: 1,
        padding: 0,
        border: "none",
        outline: "none",
        background: "transparent",
        color: "transparent",
        caretColor: "transparent",
        display: "block",
      }}
    />
  );
}
