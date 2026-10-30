import { BookmarkIcon, CheckIcon } from "../icons";

// The stash button: a small bookmark in the message field just before
// Send, there only while the field is empty (no text, no files), so it
// never crowds a draft. A tap opens the stash sheet. Right after a save
// (which empties the field) it shows a check for a moment.

export function StashButton({ onOpen, flash, open }: { onOpen: () => void; flash: boolean; open: boolean }) {
  return (
    <button
      type="button"
      data-testid="stash-button"
      data-flash={flash || undefined}
      aria-label="Stash"
      aria-haspopup="dialog"
      aria-expanded={open}
      // Like ＋: a blur here would drop the keyboard and slide the
      // composer down mid-tap, so the click would miss. The Thread puts
      // the keyboard away itself when the sheet opens.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      className="shrink-0 flex items-center justify-center bg-transparent border-0"
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        color: flash ? "var(--success)" : "var(--text-muted)",
        transition: "color 160ms ease",
      }}
    >
      {flash ? (
        <CheckIcon size={18} strokeWidth={2} testId="stash-button-saved" />
      ) : (
        <BookmarkIcon size={18} strokeWidth={1.75} />
      )}
    </button>
  );
}
