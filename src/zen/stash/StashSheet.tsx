import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/androidBack";
import { BookmarkIcon } from "../icons";
import { STASH_MAX, stashAge, stashPreview, stashSourceLabel } from "./stashModel";
import { useLiveStash, useStashStore } from "./stashStore";

// The stash list (phone): a bottom sheet over the Thread, newest first.
// Each row shows a preview, where it came from, its age and a files badge;
// a tap puts it in the composer (the Thread inserts it below any text),
// ✕ deletes it; the header's X closes it. Opened from the bookmark in an
// empty message field.

const MUTED = "#8e8e93";

export function StashSheet({ onChoose, onClose }: { onChoose: (id: string) => void; onClose: () => void }) {
  useBackHandler(true, onClose);
  const hydrate = useStashStore((s) => s.hydrate);
  const remove = useStashStore((s) => s.remove);
  const items = useLiveStash();
  const unavailable = useStashStore((s) => s.unavailable);
  // Ages are read once a minute while the sheet is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void hydrate();
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [hydrate]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="stash-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Stash"
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "14px 0 max(12px, var(--safe-bottom))",
          maxHeight: "75vh",
          color: "#fff",
        }}
      >
        <div className="flex items-center px-4 pb-2" style={{ gap: 8 }}>
          <h2 className="flex-1 text-[17px] font-semibold">Stash</h2>
          <span className="text-[13px] tabular-nums" style={{ color: MUTED }} data-testid="stash-sheet-count">
            {items.length} of {STASH_MAX}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{ width: 30, height: 30, color: "#fff" }}
            aria-label="Close"
            data-testid="stash-sheet-close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {items.length === 0 && unavailable ? (
          <p className="text-[14px] text-center px-8 py-8 leading-snug" style={{ color: MUTED }} role="alert" data-testid="stash-unavailable">
            Your stash isn't available on this phone right now. Try again in a moment.
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center text-center px-8 py-8" style={{ gap: 10, color: MUTED }} data-testid="stash-empty">
            <BookmarkIcon size={28} strokeWidth={1.5} />
            <p className="text-[14px] leading-snug">
              Nothing stashed yet. While you type, tap ＋ and choose Save to stash to keep the message for later. Or hold an agent's message and choose Save to stash.
            </p>
          </div>
        ) : (
          <ul className="overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch" }} data-testid="stash-list">
            {items.map((item) => {
              const source = stashSourceLabel(item.source);
              const files = item.attachments.length;
              return (
                <li key={item.id} className="flex items-stretch" style={{ borderTop: "0.5px solid rgba(255,255,255,0.12)" }}>
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left px-4 py-2.5"
                    data-testid="stash-item"
                    onClick={() => onChoose(item.id)}
                  >
                    <span className="block text-[15px] leading-snug line-clamp-2 break-words">{stashPreview(item)}</span>
                    <span className="flex items-center gap-1.5 mt-0.5 text-[12px]" style={{ color: MUTED }}>
                      {source ? <span className="min-w-0 truncate">{source}</span> : null}
                      {source ? <span aria-hidden="true">·</span> : null}
                      <span className="flex-none tabular-nums">{stashAge(item.created_at, now)}</span>
                      {files ? (
                        <span
                          className="flex-none rounded-full px-1.5"
                          style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}
                          data-testid="stash-item-files"
                        >
                          {files === 1 ? "1 file" : `${files} files`}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete "${stashPreview(item).slice(0, 40)}"`}
                    className="flex-none flex items-center justify-center text-[15px]"
                    style={{ width: 48, color: MUTED }}
                    data-testid="stash-item-delete"
                    onClick={() => void remove(item.id)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body
  );
}

/** "Your stash is full (50). Remove the oldest?" Nothing is dropped
 *  without this. */
export function StashFullDialog({ onReplace, onCancel }: { onReplace: () => void; onCancel: () => void }) {
  useBackHandler(true, onCancel);
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-8"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 65, fontFamily: "var(--zen-font)" }}
      data-testid="stash-full"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-label="Stash full" className="w-full k2-tile k2-tile-sheet text-center" style={{ maxWidth: 300, borderRadius: 14, color: "#fff" }}>
        <p className="text-[15px] leading-snug px-4 pt-4 pb-3">
          Your stash is full ({STASH_MAX}). Remove the oldest?
        </p>
        <div className="flex" style={{ borderTop: "0.5px solid rgba(255,255,255,0.15)" }}>
          <button type="button" className="flex-1 py-2.5 text-[16px]" style={{ color: "#0a84ff" }} onClick={onCancel} data-testid="stash-full-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="flex-1 py-2.5 text-[16px] font-semibold"
            style={{ color: "#ff453a", borderLeft: "0.5px solid rgba(255,255,255,0.15)" }}
            onClick={onReplace}
            data-testid="stash-full-replace"
          >
            Remove oldest
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
