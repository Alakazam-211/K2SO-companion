import { useEffect, useRef } from "react";
import { currentMatchIndex, stepMatchIndex, threadSearchStatus } from "./threadSearch";
import { useThreadSearch } from "./threadSearchStore";

const BTN = { width: 30, height: 30, color: "#fff" } as const;

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={up ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
    </svg>
  );
}

/** The Thread's search field, over the header's title while open: the
 *  query, "2 of 12", older (up) and newer (down), and close. Return goes
 *  older, as on desktop. */
export function ThreadSearchField({ onClose }: { onClose: () => void }) {
  const query = useThreadSearch((s) => s.query);
  const matches = useThreadSearch((s) => s.matches);
  const current = useThreadSearch((s) => s.current);
  const searching = useThreadSearch((s) => s.searching);
  const setQuery = useThreadSearch((s) => s.setQuery);
  const setCurrent = useThreadSearch((s) => s.setCurrent);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const index = currentMatchIndex(matches, current);
  const status = threadSearchStatus({ query, index, total: matches.length, searching });
  const step = (dir: 1 | -1) => {
    const i = stepMatchIndex(index, matches.length, dir);
    if (i >= 0) setCurrent(matches[i].key);
  };
  return (
    <div
      className="flex items-center min-w-0 zen-glass zen-glass-field"
      style={{ height: 36, padding: "0 4px 0 12px", gap: 2, pointerEvents: "auto" }}
      data-testid="thread-search"
    >
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search this chat"
        aria-label="Search this chat"
        className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[16px]"
        style={{ color: "#fff" }}
        data-testid="thread-search-input"
      />
      <span
        className="shrink-0 text-[12px]"
        style={{ color: "#8e8e93", fontVariantNumeric: "tabular-nums", padding: "0 4px" }}
        aria-live="polite"
        aria-label={status.spoken || undefined}
        data-testid="thread-search-count"
      >
        {status.text}
      </span>
      <button
        type="button"
        className="flex items-center justify-center shrink-0 bg-transparent border-0"
        style={BTN}
        disabled={!matches.length}
        aria-label="Older match"
        onClick={() => step(1)}
        data-testid="thread-search-older"
      >
        <Chevron up />
      </button>
      <button
        type="button"
        className="flex items-center justify-center shrink-0 bg-transparent border-0"
        style={BTN}
        disabled={!matches.length}
        aria-label="Newer match"
        onClick={() => step(-1)}
        data-testid="thread-search-newer"
      >
        <Chevron up={false} />
      </button>
      <button
        type="button"
        className="flex items-center justify-center shrink-0 bg-transparent border-0"
        style={BTN}
        aria-label="Close search"
        onClick={onClose}
        data-testid="thread-search-close"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
