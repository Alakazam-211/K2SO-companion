// A yes / no question as a bottom sheet (the app's confirm-sheet look:
// Usage's Make default). The safe answer is focused, so Delete asks
// "Delete #name?" with **Keep it** focused (desktop `safeDefault`).

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/androidBack";

export function HomeChatConfirmSheet({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  testId = "home-chat-confirm",
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  testId?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useBackHandler(true, onCancel);
  const safeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    safeRef.current?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "var(--color-scrim)", zIndex: 62, fontFamily: "var(--zen-font)" }}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, var(--safe-bottom))",
          gap: 12,
          color: "var(--color-text-primary)",
        }}
      >
        <h2 className="text-[17px] font-semibold text-center break-words" data-testid={`${testId}-title`}>
          {title}
        </h2>
        <p className="text-[13px]" style={{ color: "var(--color-text-secondary)", lineHeight: 1.4 }} data-testid={`${testId}-body`}>
          {message}
        </p>
        <div className="flex" style={{ gap: 10 }}>
          <button
            ref={safeRef}
            type="button"
            className="flex-1 text-[17px] font-semibold k2-tile"
            style={{ minHeight: 44, borderRadius: 12, color: "var(--color-text-primary)" }}
            data-testid={`${testId}-cancel`}
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="flex-1 text-[17px]"
            style={{
              minHeight: 44,
              borderRadius: 12,
              color: destructive ? "var(--color-on-danger)" : "var(--color-on-accent)",
              background: destructive ? "var(--color-danger)" : "var(--color-accent-fill)",
              opacity: busy ? 0.6 : 1,
            }}
            data-testid={`${testId}-go`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
