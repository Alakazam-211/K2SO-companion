import { useEffect } from "react";
import { BookmarkIcon } from "../icons";
import { useLiveStash, useStashStore } from "./stashStore";
import { DRAWER_TILE_PX } from "../ThreadWorkingStrip";

// The stash button: a small glass tab pulled out of the composer field's
// top edge at the right, beside the working drawer (GlassComposer's
// `drawerAside` slot), always there. Bookmark + count; "Saved" for a
// moment after a save. A tap opens the stash sheet.

/** The tab's width (px); the working drawer leaves this much room. */
export const STASH_TAB_W = 44;
/** Its height above the field: the collapsed drawer's. */
export const STASH_TAB_PX = DRAWER_TILE_PX;

const RADIUS = "var(--k2-drawer-radius, 15px)";
const TUCK = "var(--k2-drawer-tuck, 0px)";

export function StashTab({ onOpen, flash, open }: { onOpen: () => void; flash: boolean; open: boolean }) {
  const hydrate = useStashStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  const count = useLiveStash().length;
  return (
    <button
      type="button"
      data-testid="stash-tab"
      data-flash={flash || undefined}
      aria-label={count ? `Stash, ${count} saved` : "Stash"}
      aria-haspopup="dialog"
      aria-expanded={open}
      // Like ＋: a blur here would drop the keyboard and slide the
      // composer down mid-tap, so the click would miss. The Thread puts
      // the keyboard away itself when the sheet opens.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      className="k2-tile k2-tile-sheet k2-drawer-tile relative flex w-full items-center justify-center gap-1 pointer-events-auto"
      style={{
        height: `calc(${STASH_TAB_PX}px + ${TUCK})`,
        paddingBottom: TUCK,
        borderRadius: `${RADIUS} ${RADIUS} 0 0`,
        color: flash ? "var(--success)" : count ? "var(--text)" : "var(--text-muted)",
        transition: "color 160ms ease",
      }}
    >
      {flash ? (
        <span className="text-[12px] font-semibold" data-testid="stash-tab-saved">
          Saved
        </span>
      ) : (
        <>
          <BookmarkIcon size={14} strokeWidth={2} />
          {count ? (
            <span className="text-[12px] tabular-nums leading-none" data-testid="stash-tab-count">
              {count}
            </span>
          ) : null}
        </>
      )}
    </button>
  );
}
