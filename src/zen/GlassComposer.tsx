import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FocusEventHandler,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { filesFromClipboard } from "./composerAttach";
import { zenTextPx } from "./zenFont";

/** iMessage grows the field then caps (~5 lines) and scrolls inside. */
export const COMPOSER_MAX_PX = 132;

export function composerHeight(scrollHeight: number, maxPx = COMPOSER_MAX_PX): number {
  if (!Number.isFinite(scrollHeight) || scrollHeight < 24) return 24;
  return Math.min(scrollHeight, maxPx);
}

export interface GlassComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Form submit (send bubble tap). The caller owns all send gating. */
  onSubmit: () => void;
  /** Files picked from `＋` or pasted. `＋` renders while `canSend`;
   *  disable it with `attachDisabled`. */
  onAttach?: (files: File[]) => void;
  placeholder?: string;
  /** Textarea disabled. */
  disabled?: boolean;
  /** Show `＋` and the send bubble (the thread hides both when it can't send). */
  canSend: boolean;
  /** Send bubble active (blue) — otherwise grey and disabled. */
  sendReady: boolean;
  attachDisabled?: boolean;
  /** Rows above the field (label, chips, errors). */
  children?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onFocus?: FocusEventHandler<HTMLTextAreaElement>;
  ariaLabel?: string;
  /** Test-id prefix: `${p}-bar`, `-form`, `-file-input`, `-field`,
   *  `-attach`, `-input`, `-send`. */
  testIdPrefix?: string;
  /** Extra attrs on the bar (e.g. `data-k2-variant`). */
  barProps?: Record<string, string | undefined>;
}

/** The Zen glass composer: one full-width rounded tile field holding a
 *  borderless `＋`, the auto-growing textarea and a round send bubble
 *  (grey → #0a84ff). Presentational — ThreadPane and the Zen terminal
 *  page own what attach and send do. */
export function GlassComposer({
  value,
  onChange,
  onSubmit,
  onAttach,
  placeholder = "Message",
  disabled,
  canSend,
  sendReady,
  attachDisabled,
  children,
  textareaRef,
  onFocus,
  ariaLabel = "Message",
  testIdPrefix = "composer",
  barProps,
}: GlassComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const id = (s: string) => `${testIdPrefix}-${s}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${composerHeight(el.scrollHeight)}px`;
  }, [value, ref]);

  const onPasteFiles = (e: ClipboardEvent) => {
    if (!onAttach) return;
    const files = filesFromClipboard(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    onAttach(files);
  };

  return (
    // zen-composer-bar: home-indicator inset at rest, collapsed while
    // typing so it is not a gap above the keyboard (.input-bar idiom).
    <div
      className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2 zen-composer-bar"
      data-testid={id("bar")}
      {...barProps}
    >
      {children}
      <form
        className="flex items-end min-w-0"
        data-testid={id("form")}
        onPaste={onPasteFiles}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid={id("file-input")}
          onChange={(e) => {
            const list = e.target.files;
            onAttach?.(list ? Array.from(list) : []);
            e.target.value = "";
          }}
        />
        <div
          className="flex-1 min-w-0 overflow-hidden flex items-end gap-1 rounded-[20px] pl-1 pr-1 py-1 k2-tile"
          data-testid={id("field")}
        >
          {canSend ? (
            <button
              type="button"
              data-testid={id("attach")}
              aria-label="Add file"
              disabled={Boolean(attachDisabled)}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 flex items-center justify-center bg-transparent border-0 text-[var(--text-muted)] disabled:opacity-40"
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                fontSize: 22,
                lineHeight: 1,
              }}
            >
              ＋
            </button>
          ) : null}
          <textarea
            ref={ref}
            disabled={disabled}
            value={value}
            rows={1}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onFocus}
            onPaste={onPasteFiles}
            placeholder={placeholder}
            className={`flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[var(--text)] outline-none py-1 ${canSend ? "" : "px-2"}`}
            style={{
              maxHeight: COMPOSER_MAX_PX,
              fontSize: zenTextPx(17),
              lineHeight: zenTextPx(22),
            }}
            aria-label={ariaLabel}
            data-testid={id("input")}
          />
          {canSend ? (
            <button
              type="submit"
              aria-label="Send"
              data-testid={id("send")}
              disabled={!sendReady}
              // Keep focus in the textarea so the iOS keyboard stays up
              // (AccessoryBar pattern). Not on attach — it opens a picker.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              className={`shrink-0 flex items-center justify-center k2-tile ${
                sendReady
                  ? "text-white"
                  : "k2-tile-raised text-[var(--text-muted)] opacity-60"
              }`}
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                ...(sendReady
                  ? { background: "#0a84ff", borderColor: "#0a84ff" }
                  : {}),
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
