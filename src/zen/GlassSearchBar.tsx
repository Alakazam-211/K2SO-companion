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
  return (
    <div
      className="absolute left-3 right-3 flex items-center"
      data-no-pin="1"
      data-testid={testId}
      style={{
        bottom: "max(14px, env(safe-area-inset-bottom))",
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
          onFocus={() => window.scrollTo(0, 0)}
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
          width: 44,
          height: 44,
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
