import { useState } from "react";

/** Gap between the bar and the iOS keyboard while typing — the same 8px
 *  the thread composer keeps (`.zen-composer-bar:focus-within`). */
export const SEARCH_BAR_KEYBOARD_GAP = 8;
/** Resting offset: clear the home indicator (as `.zen-composer-bar`). */
export const SEARCH_BAR_REST_BOTTOM = "max(14px, env(safe-area-inset-bottom))";
/** Bar row height (the round `+`). */
export const SEARCH_BAR_HEIGHT = 44;

/** Bottom glass bar shared by Chats and the Servers sheet: a search field
 *  plus a round `+` button. Absolutely positioned at the bottom of its
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
}: {
  query: string;
  onQuery: (value: string) => void;
  placeholder?: string;
  searchLabel?: string;
  onPlus: () => void;
  plusLabel: string;
  testId?: string;
  inputTestId?: string;
  plusTestId?: string;
}) {
  // Typing = keyboard up. The column above is already sized to the visual
  // viewport, so the home-indicator inset would be a dead gap over the
  // keyboard; drop to the composer's 8px instead.
  const [typing, setTyping] = useState(false);
  const bottom = typing ? `${SEARCH_BAR_KEYBOARD_GAP}px` : SEARCH_BAR_REST_BOTTOM;
  return (
    <div
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
      </label>
      <button
        type="button"
        title={plusLabel}
        aria-label={plusLabel}
        className="flex items-center justify-center zen-glass zen-glass-round"
        style={{
          width: SEARCH_BAR_HEIGHT,
          height: SEARCH_BAR_HEIGHT,
          color: "#fff",
        }}
        onClick={onPlus}
        data-testid={plusTestId}
      >
        +
      </button>
    </div>
  );
}
