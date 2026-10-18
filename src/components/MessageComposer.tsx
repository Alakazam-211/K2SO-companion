import { useLayoutEffect, useRef, type ReactNode } from "react";
import { GlassComposer } from "../zen/GlassComposer";

// The shared mobile composer — the terminal (ChatSession) input bar,
// extracted so Projects chat and Feedback threads reuse the exact same
// pattern: an auto-growing textarea where Return inserts a NEWLINE, and
// a thumb-sized ↑ button that is the one deliberate way to send. This
// is the standard mobile-chat pattern (no Return-to-send, no keyboard-
// combo hints — those are desktop-isms).
//
// The bar carries the `.input-bar` bottom-inset idiom (home-indicator
// padding that collapses while the keyboard is up) and `flexShrink: 0`
// so it slots directly into the keyboard-height column layouts
// (ChatSession's containerHeight / useViewportHeight overlays).

export interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on a ↑ tap; never fires while empty, `disabled`, or `busy`. */
  onSend: () => void;
  placeholder?: string;
  /** Hard-disable sending (beyond the built-in empty-draft guard). */
  disabled?: boolean;
  /** A send is in flight — the ↑ button dims until it settles. */
  busy?: boolean;
  /** Optional rows above the input (error / receipt / status actions). */
  accessory?: ReactNode;
  /** Optional row at the very top of the bar (e.g. the terminal's
   *  Safe send / Direct type segmented control). Renders above
   *  `accessory`. */
  headerSlot?: ReactNode;
  /** Visual tint of the whole strip. `"warning"` = the terminal's
   *  Direct-type state — keystrokes are live on a shared PTY, so the
   *  bar itself must FEEL hot. Default is the normal surface. */
  tint?: "default" | "warning";
  /** Rest slightly higher while the keyboard is collapsed (chat pages —
   *  keeps the input's corners clear of the home-indicator curve). */
  lift?: boolean;
  /** `"zen"` = the Zen thread's glass composer (GlassComposer: one tile
   *  field with `＋`, the textarea and a send bubble inside). Same send
   *  gating and Return-inserts-newline behaviour; the default look is
   *  untouched. */
  variant?: "default" | "zen";
  /** Zen only: files picked from `＋` (or pasted). Without it `＋` is
   *  disabled. */
  onAttach?: (files: File[]) => void;
  /** Zen only: a pick left files out or failed (GlassComposer). */
  onAttachError?: (message: string) => void;
  /** Zen only: hard-disable `＋` (e.g. an upload is in flight). */
  attachDisabled?: boolean;
  /** Zen only: GlassComposer test-id prefix. */
  testIdPrefix?: string;
  /** Zen only: the textarea gained focus (e.g. the terminal page
   *  auto-claims Drive when you tap into the field). */
  onFocus?: () => void;
}

export function MessageComposer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  busy,
  accessory,
  headerSlot,
  tint,
  lift,
  variant = "default",
  onAttach,
  onAttachError,
  attachDisabled,
  testIdPrefix,
  onFocus,
}: MessageComposerProps) {
  if (variant === "zen") {
    const sendReady = !disabled && !busy && Boolean(value.trim());
    return (
      <GlassComposer
        value={value}
        onChange={onChange}
        onSubmit={() => {
          if (sendReady) onSend();
        }}
        onAttach={onAttach}
        onAttachError={onAttachError}
        placeholder={placeholder}
        canSend
        sendReady={sendReady}
        attachDisabled={!onAttach || Boolean(attachDisabled)}
        testIdPrefix={testIdPrefix}
        onFocus={onFocus ? () => onFocus() : undefined}
        barProps={{ "data-k2-variant": "zen" }}
      >
        {headerSlot}
        {accessory}
      </GlassComposer>
    );
  }
  return (
    <ClassicComposer
      value={value}
      onChange={onChange}
      onSend={onSend}
      placeholder={placeholder}
      disabled={disabled}
      busy={busy}
      accessory={accessory}
      headerSlot={headerSlot}
      tint={tint}
      lift={lift}
    />
  );
}

function ClassicComposer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  busy,
  accessory,
  headerSlot,
  tint,
  lift,
}: Omit<
  MessageComposerProps,
  "variant" | "onAttach" | "attachDisabled" | "testIdPrefix" | "onFocus"
>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with the draft: 44px (one line, thumb-sized) up to 100px,
  // then scroll inside — the ChatSession terminal-composer behavior.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    const h = Math.min(Math.max(el.scrollHeight, 44), 100);
    el.style.height = h + "px";
    el.style.overflow = el.scrollHeight > 100 ? "auto" : "hidden";
  }, [value]);

  const sendDisabled = Boolean(disabled) || Boolean(busy) || !value.trim();
  const send = () => {
    if (sendDisabled) return;
    onSend();
  };

  const warn = tint === "warning";

  return (
    <div
      className={`px-4 pt-3 border-t border-[var(--border)] bg-[var(--surface)] input-bar${lift ? " input-bar-lift" : ""}`}
      style={{
        flexShrink: 0,
        // Warning tint (Direct type): amber-wash the strip + its top rule
        // so live-keystroke mode is unmistakable at a glance.
        ...(warn
          ? {
              background: "var(--warning-10)",
              borderTopColor: "var(--warning)",
            }
          : {}),
      }}
    >
      {headerSlot}
      {accessory}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Return inserts a newline (the textarea grows via the [value]
          // effect above) — sending is a deliberate tap on the ↑ button.
          placeholder={placeholder}
          rows={1}
          className="flex-1 bg-[var(--background)] border border-[var(--accent-dim)] px-3 text-[var(--text)] text-[13px] focus:outline-none resize-none"
          style={{
            height: 44,
            lineHeight: "20px",
            padding: "12px 12px",
            overflow: "hidden",
          }}
        />
        <button
          onTouchEnd={(e) => {
            e.preventDefault();
            send();
          }}
          onClick={send}
          disabled={sendDisabled}
          aria-label="Send"
          className="w-11 h-11 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 self-end disabled:opacity-40"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
