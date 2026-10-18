import type { PointerEvent as ReactPointerEvent } from "react";
import { SEARCH_BAR_HEIGHT, SEARCH_BAR_REST_BOTTOM } from "./GlassSearchBar";

/** Extra left room a row gets for its grip in Rearrange mode. The grip
 *  glyph sits clear of the unread dot (16px left of the avatar). */
export const GRIP_W = 40;
const GRIP_GAP_RIGHT = 18;

/** Row padding-left in Rearrange mode. */
export function rearrangePadLeft(inset: string, on: boolean): string {
  return on ? `calc(${inset} + ${GRIP_W}px)` : inset;
}

/** The ≡ grip left of a row's avatar. Its box is the row's whole left
 *  strip (a big touch target); only it starts a drag (touch-action none),
 *  so the rest of the row still pans the list. */
export function GripHandle({
  name,
  inset,
  handlers,
}: {
  name: string;
  inset: string;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
}) {
  return (
    <span
      role="img"
      aria-label={`Reorder ${name}`}
      className="absolute top-0 bottom-0 left-0 flex items-center justify-end"
      style={{
        width: `calc(${inset} + ${GRIP_W}px)`,
        paddingRight: GRIP_GAP_RIGHT,
        zIndex: 1,
        color: "#8e8e93",
        touchAction: "none",
        cursor: "grab",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
      data-no-pin="1"
      data-testid="rearrange-grip"
      {...handlers}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </span>
  );
}

/** Blue "Done" pill: bottom right, just above the search field and `+`. */
export function RearrangeDone({ onDone }: { onDone: () => void }) {
  return (
    <button
      type="button"
      className="absolute flex items-center justify-center border-0 text-[16px] font-semibold"
      style={{
        zIndex: 6,
        right: 16,
        bottom: `calc(${SEARCH_BAR_REST_BOTTOM} + ${SEARCH_BAR_HEIGHT + 12}px)`,
        height: 40,
        padding: "0 22px",
        borderRadius: 20,
        background: "#0a84ff",
        color: "#fff",
        boxShadow: "0 6px 18px rgba(0,0,0,.35)",
      }}
      data-no-pin="1"
      data-testid="rearrange-done"
      onClick={onDone}
    >
      Done
    </button>
  );
}
