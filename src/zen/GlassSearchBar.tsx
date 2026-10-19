import { useEffect, useState, type ReactNode, type Ref } from "react";
import { PlusGlyph } from "./PlusGlyph";
import { FOOTER_BLUR_FADE_PX, ZenFooterBlur } from "./ZenHeaderBlur";

/** Gap between the bar and the iOS keyboard while typing — the same 8px
 *  the thread composer keeps (`.zen-composer-bar:focus-within`). */
export const SEARCH_BAR_KEYBOARD_GAP = 8;
/** Resting offset: clear the home indicator (as `.zen-composer-bar`). */
export const SEARCH_BAR_REST_BOTTOM = "max(14px, var(--safe-bottom))";
/** Android, typing: --safe-bottom is 0 under a docked keyboard (so the
 *  8px gap), but a floating or hardware keyboard leaves the nav bar
 *  exposed and the bar must still clear it (as `.zen-composer-bar`). */
export const SEARCH_BAR_ANDROID_TYPING_BOTTOM = `max(${SEARCH_BAR_KEYBOARD_GAP}px, var(--safe-bottom))`;

function typingBottom(): string {
  return document.documentElement.classList.contains("platform-android")
    ? SEARCH_BAR_ANDROID_TYPING_BOTTOM
    : `${SEARCH_BAR_KEYBOARD_GAP}px`;
}
/** Bar row height (the round `+`). */
export const SEARCH_BAR_HEIGHT = 44;

/** Bottom glass bar shared by Chats and the Servers sheet: a search field
 *  plus a circular `+` button (the composer's attach `PlusGlyph`), on the
 *  header's blur stack flipped (`ZenFooterBlur`, full width, from just
 *  above the bar to the bottom edge) so rows soften as they pass under.
 *  Absolutely positioned at the bottom of its
 *  nearest positioned ancestor — size that ancestor to the visual viewport
 *  (`useViewportHeight`) so the bar clears the iOS keyboard. */
export function GlassSearchBar({
  query,
  onQuery,
  placeholder = "Search",
  searchLabel = "Search",
  onPlus,
  plusLabel,
  testId,
  inputTestId,
  plusTestId,
  plusBlockedNote,
  leading,
  barRef,
  blurRef,
}: {
  /** The bar and its blur, for a screen that moves them with the
   *  keyboard (mobile chat kit FLIP). */
  barRef?: Ref<HTMLDivElement>;
  blurRef?: Ref<HTMLDivElement>;
  query: string;
  onQuery: (value: string) => void;
  placeholder?: string;
  searchLabel?: string;
  /** Omit (with `plusLabel`) for a search-only bar (Projects sheet). */
  onPlus?: () => void;
  plusLabel?: string;
  testId?: string;
  inputTestId?: string;
  plusTestId?: string;
  /** Set when this login can't use `+`: the button dims, and a tap shows
   *  this note above it instead of calling `onPlus` (no hover on iOS). */
  plusBlockedNote?: string | null;
  /** Drawn left of the search field (the Agents list's Home | Agents
   *  toggle). The field shrinks to fit. */
  leading?: ReactNode;
}) {
  // Typing = keyboard up. The column above is already sized to the visual
  // viewport, so the home-indicator inset would be a dead gap over the
  // keyboard; drop to the composer's 8px instead.
  const [typing, setTyping] = useState(false);
  const bottom = typing ? typingBottom() : SEARCH_BAR_REST_BOTTOM;
  const [noteUp, setNoteUp] = useState(false);
  useEffect(() => {
    if (!noteUp) return;
    const t = setTimeout(() => setNoteUp(false), 3000);
    return () => clearTimeout(t);
  }, [noteUp]);
  const blocked = !!plusBlockedNote;
  return (
    <>
    <ZenFooterBlur
      elRef={blurRef}
      testId={testId ? `${testId}-blur` : "search-bar-blur"}
      style={{
        left: 0,
        right: 0,
        bottom: 0,
        // Follows the bar: the resting inset, or the 8px gap while typing.
        height: `calc(${bottom} + ${SEARCH_BAR_HEIGHT + FOOTER_BLUR_FADE_PX}px)`,
        // Same layer as the bar, drawn first: the bar stays on top.
        zIndex: 4,
      }}
    />
    <div
      ref={barRef}
      className="absolute left-3 right-3 flex items-center"
      data-no-pin="1"
      data-testid={testId}
      data-typing={typing ? "1" : undefined}
      // jsdom drops `max(env())`; mirror the applied offset for tests.
      data-bottom={bottom}
      style={{
        bottom,
        gap: 10,
        zIndex: 4,
      }}
    >
      {leading}
      <label
        className="flex-1 min-w-0 flex items-center zen-glass zen-glass-field"
        style={{
          gap: 8,
          padding: "9px 14px",
        }}
      >
        <span className="sr-only">{searchLabel}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => {
            setTyping(true);
            window.scrollTo(0, 0);
          }}
          onBlur={() => setTyping(false)}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[17px]"
          style={{ color: "#fff" }}
          aria-label={searchLabel}
          data-testid={inputTestId}
        />
        {query ? (
          <button
            type="button"
            className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{ width: 24, height: 24, margin: "-2px -6px -2px 0", color: "#fff" }}
            // Keep focus in the field so the iOS keyboard stays up.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onQuery("")}
            aria-label="Clear search"
            data-testid={inputTestId ? `${inputTestId}-clear` : "search-clear"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
      </label>
      {blocked && noteUp ? (
        <div
          role="status"
          className="absolute right-0 zen-glass zen-glass-pill text-[13px]"
          style={{
            bottom: SEARCH_BAR_HEIGHT + 8,
            padding: "8px 12px",
            maxWidth: "80%",
            color: "#fff",
          }}
          data-testid={plusTestId ? `${plusTestId}-note` : "search-plus-note"}
        >
          {plusBlockedNote}
        </div>
      ) : null}
      {onPlus ? (
      <button
        type="button"
        title={blocked ? plusBlockedNote ?? plusLabel : plusLabel}
        aria-label={plusLabel}
        aria-disabled={blocked ? true : undefined}
        className="flex items-center justify-center zen-glass zen-glass-round"
        style={{
          width: SEARCH_BAR_HEIGHT,
          height: SEARCH_BAR_HEIGHT,
          // Perfect circle (overrides `.zen-glass-round`'s 16px corners).
          borderRadius: "50%",
          flexShrink: 0,
          opacity: blocked ? 0.4 : undefined,
        }}
        onClick={() => {
          if (blocked) setNoteUp(true);
          else onPlus();
        }}
        data-testid={plusTestId}
      >
        <PlusGlyph bright />
      </button>
      ) : null}
    </div>
    </>
  );
}
