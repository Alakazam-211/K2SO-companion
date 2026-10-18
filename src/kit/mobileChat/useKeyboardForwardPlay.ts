// Keyboard motion for a screen whose content must not re-lay out during
// the animation (a terminal grid re-fits its rows on every size change):
// the layout is held for the whole motion and committed once at its end.
//   - motion starts: `hold.begin()` pins what must not resize (show: the
//     column is held at `from` by keyboardColumnHeight; hide: the column
//     goes final, so the screen pins e.g. the grid's height), and the
//     movers (the composer) play by transform to where the final layout
//     will put them, on the keyboard's duration + curve;
//   - motion clears: transforms off and `hold.end()` in the same commit —
//     the content re-fits ONCE.
// Reduced motion / no motion: nothing to do (the layout is final).

import { useLayoutEffect, useRef } from "react";
import { keyboardFlipTransition, type ViewportMotion } from "../../lib/useViewportHeight";

export function useKeyboardForwardPlay(opts: {
  motion: ViewportMotion | null | undefined;
  movers: () => (HTMLElement | null)[];
  hold?: { begin(m: ViewportMotion): void; end(): void };
  enabled?: boolean;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  const playing = useRef(false);
  const m = opts.motion ?? null;
  const enabled = opts.enabled ?? true;
  useLayoutEffect(() => {
    const movers = ref.current.movers().filter((x): x is HTMLElement => !!x);
    if (!enabled) return;
    if (!m) {
      if (!playing.current) return;
      playing.current = false;
      for (const x of movers) {
        x.style.transition = "none";
        x.style.transform = "";
      }
      ref.current.hold?.end();
      return;
    }
    if (!playing.current) ref.current.hold?.begin(m);
    playing.current = true;
    const play = keyboardFlipTransition(m);
    const dy = m.to - m.from;
    for (const x of movers) {
      x.style.transition = play;
      x.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : "";
    }
  }, [m, enabled]);
}
