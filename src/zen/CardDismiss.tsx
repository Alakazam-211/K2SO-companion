// Dismiss for a waiting question card on the phone (K2 0.46.11,
// prd-popup-close-and-card-dismiss-v1 B8; Riley 2026-11-14 "add that to
// mobile as well"). The desktop's CardDismiss, sized for a bubble: a small
// "Dismiss" under the options; pressed, an optional one-line reason (at most
// 200 characters), "Dismiss card" and "Keep". The daemon closes it as
// dismissed for everyone, keeps it in the history and tells the agent;
// nothing is decided. A refusal shows on the card in the daemon's words.

import { useState } from "react";
import { CARD_DISMISS_REASON_MAX } from "./threadModel";
import { useZenStore } from "./zenStore";

export const CARD_DISMISS_HINT = "Closes the card without answering. The agent is told; nothing is decided.";

export function CardDismiss({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = () => {
    setOpen(false);
    setReason("");
    setError(null);
  };
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await useZenStore.getState().dismissCard(id, reason.trim() || undefined);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setOpen(false);
  };
  if (!open) {
    return (
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          data-testid="thread-card-dismiss"
          onClick={() => setOpen(true)}
          className="-mr-1 px-1 py-0.5 text-[13px] leading-none"
          style={{ color: "rgba(255,255,255,0.65)" }}
          aria-label="Dismiss this card without answering it"
        >
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div data-testid="thread-card-dismiss-form" className="mt-2 flex flex-col gap-1.5">
      <input
        autoFocus
        data-testid="thread-card-dismiss-reason"
        value={reason}
        maxLength={CARD_DISMISS_REASON_MAX}
        disabled={busy}
        enterKeyHint="done"
        onChange={(e) => setReason(e.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            keep();
          }
        }}
        placeholder="Why? (optional)"
        aria-label="Why you are dismissing this card (optional)"
        className="w-full rounded-lg px-2.5 py-1.5 outline-none"
        // 16px: iOS zooms into a smaller field.
        style={{ fontSize: 16, color: "#fff", background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.25)" }}
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="thread-card-dismiss-confirm"
          disabled={busy}
          onClick={() => void send()}
          className="rounded-full px-3 py-1.5 text-[15px] leading-none border"
          style={{ borderColor: "rgba(255,255,255,0.4)", color: "#fff", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Dismissing…" : "Dismiss card"}
        </button>
        <button
          type="button"
          data-testid="thread-card-dismiss-keep"
          disabled={busy}
          onClick={keep}
          className="rounded-full px-3 py-1.5 text-[15px] leading-none border"
          style={{ borderColor: "rgba(255,255,255,0.4)", color: "#fff", opacity: busy ? 0.6 : 1 }}
        >
          Keep
        </button>
      </div>
      <p className="text-[12px] leading-snug" style={{ color: "rgba(255,255,255,0.65)" }}>
        {CARD_DISMISS_HINT}
      </p>
      {error ? (
        <p data-testid="thread-card-dismiss-error" role="alert" className="text-[12px] leading-snug" style={{ color: "#ff9f9a" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
