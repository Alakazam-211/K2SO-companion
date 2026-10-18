// Keyboard show / hide on the compositor (FLIP), with no per-frame layout
// or scroll writes. The store (useViewport) publishes `motion` {from, to,
// ms, easing, elapsed}; the screen's column follows `keyboardColumnHeight`
// (final at once on hide, held at `from` on show). This hook moves the
// docked composer (and the list, when it must move) by transform:
//   - hide: the layout is final. Re-stick if the reader was at the end;
//     the docks — and, if that commit moved the list (re-stick / clamp),
//     the list's children — start translated back to where they were
//     drawn, are flushed, and play to 0 on the keyboard's own duration +
//     curve (mid-curve by the bridge hop);
//   - show: the column is held; the docks (and the list, if the reader is
//     at the end) play up to where the new layout will put them; when the
//     motion clears the column takes its height and the transforms go in
//     the same commit, re-stuck — the same picture.
// After an interactive drag the finger owns the scroll: the list is never
// moved or re-stuck, only the docks play (the drag hand-off placed them).

import { useLayoutEffect, useRef } from "react";
import { keyboardFlipTransition, type ViewportMotion } from "../../lib/useViewportHeight";

/** How a list that sticks to its newest item takes part. */
export type FlipList = {
  /** The reader is at the end (the list moves with the keyboard). */
  isFollowing(): boolean;
  /** scrollTop as last seen before this commit (onScroll / own writes). */
  lastScrollTop(): number;
  /** Re-stick to the end (a no-op when not following). */
  stick(): void;
  /** Hold the list still (an anchor is being restored). */
  held?(): boolean;
  /** Its content sits at the bottom (.mchat-content + flex-end): while
   *  following, the newest moves exactly with the composer even when the
   *  list does not scroll. (K2's lists are top-aligned at rest.) */
  bottomAnchored?: boolean;
  /** The list's content block (.mchat-content): lets the FLIP measure how
   *  far the content itself moved (scroll AND spacers above it) and predict
   *  a short list's layout. */
  content?(): HTMLElement | null;
  /** On a keyboard hide (not a drag release): drop transient spacers above
   *  the content now (the scroll room), so the content goes to its resting
   *  place in this one motion instead of snapping later. */
  beforeHide?(): void;
};

export type KeyboardFlipOptions = {
  /** The column's published height (useViewport().height). */
  viewportHeight: number | null | undefined;
  motion: ViewportMotion | null | undefined;
  /** An interactive dismiss drag is in progress (useViewport().interactive). */
  interactive?: boolean;
  scroller: () => HTMLElement | null;
  /** Elements docked to the column's bottom (composer, its blur…). The
   *  first one is required. */
  docks: () => (HTMLElement | null)[];
  /** Omit for a list that does not stick to its end (it then never moves). */
  list?: FlipList | null;
  enabled?: boolean;
};

function setT(els: HTMLElement[], y: number, transition: string): void {
  for (const x of els) {
    x.style.transition = transition;
    x.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
  }
}

/** The scrollTop a following list re-sticks to once its viewport has
 *  shrunk by `growth`. A content block that fills the view (.mchat-content)
 *  shrinks with it down to its children's natural height, so a short list
 *  may not scroll at all; a long one gains `growth` of range. */
export function finalScrollTop(el: HTMLElement, content: HTMLElement | null, growth: number): number {
  let sh = el.scrollHeight;
  if (content) {
    const kids = Array.from(content.children) as HTMLElement[];
    let natural = 0;
    if (kids.length) {
      const first = kids[0].getBoundingClientRect();
      const last = kids[kids.length - 1].getBoundingClientRect();
      natural = Math.max(0, last.bottom - first.top);
    }
    const fill = content.offsetHeight;
    sh = sh - fill + Math.max(natural, fill - growth);
  }
  return Math.max(0, sh - (el.clientHeight - growth));
}

export function useKeyboardFlip(o: KeyboardFlipOptions): void {
  const { viewportHeight, motion, interactive = false, enabled = true } = o;
  const opts = useRef(o);
  opts.current = o;
  const flipList = useRef(0);
  // The running motion is a drag's release (its end must not re-stick).
  const dragMotion = useRef(false);
  // A drag happened; the next keyboard motion is its release.
  const afterDrag = useRef(false);
  if (interactive) afterDrag.current = true;

  useLayoutEffect(() => {
    if (!enabled) return;
    const { scroller, docks, list } = opts.current;
    const el = scroller();
    const ds = docks().filter((d): d is HTMLElement => !!d);
    const dock = ds[0];
    if (viewportHeight == null || !el || !dock) return;
    const listEls = () => Array.from(el.children) as HTMLElement[];
    const m = motion ?? null;
    const dragged = (afterDrag.current && !interactive) || (!!m && dragMotion.current);
    if (!m) {
      // No motion / the motion is over: final layout, no transforms.
      const moved = flipList.current !== 0;
      setT(ds, 0, "none");
      if (moved) setT(listEls(), 0, "none");
      flipList.current = 0;
      if (dragged || dragMotion.current) {
        afterDrag.current = false;
        dragMotion.current = false;
      } else if (list && (moved || list.isFollowing())) list.stick();
      return;
    }
    dragMotion.current = dragged;
    const play = keyboardFlipTransition(m);
    if (m.to > m.from) {
      // Hide: layout is final; invert, then play to 0.
      const content = list?.content?.() ?? null;
      const top = () => (content ? content.offsetTop : 0);
      // Where the content was drawn (its offset in the scroller − scroll).
      const before = top() - (list ? list.lastScrollTop() : el.scrollTop);
      if (list && !dragged) {
        list.beforeHide?.(); // the scroll room goes now, in this motion
        list.stick();
      }
      const after = top() - el.scrollTop;
      setT(ds, m.from - m.to, "none");
      // How far the content moved in this commit: re-stick / clamp / the
      // room leaving (a short chat goes back to its top-aligned rest in
      // this one glide). Bottom-anchored and following: it rides the
      // composer (moved by the column's growth).
      const moved =
        list && !dragged && list.bottomAnchored && list.isFollowing()
          ? m.to - m.from
          : after - before;
      flipList.current = list && !dragged && Math.abs(moved) >= 0.5 ? -moved : 0;
      if (flipList.current) setT(listEls(), flipList.current, "none");
      void dock.getBoundingClientRect(); // flush: start from the inverted spot
      setT(ds, 0, play);
      if (flipList.current) setT(listEls(), 0, play);
      return;
    }
    // Show: play forward to the layout the motion's end will commit.
    const growth = m.from - m.to; // the list's viewport shrinks by this
    const rise =
      list && !dragged && list.isFollowing() && !list.held?.()
        ? list.bottomAnchored
          ? growth
          : Math.max(0, Math.min(growth, finalScrollTop(el, list.content?.() ?? null, growth) - el.scrollTop))
        : 0;
    setT(ds, m.to - m.from, play);
    flipList.current = rise ? -rise : 0;
    if (rise) setT(listEls(), -rise, play);
  }, [viewportHeight, motion, enabled]);

  // A drag that ended without a height change (spring back): done too.
  useLayoutEffect(() => {
    if (!interactive) afterDrag.current = false;
  }, [interactive]);
}

/** The column height a FLIP screen renders: full during an interactive
 *  dismiss (beginKeyboardDrag set it), held at `from` while the keyboard
 *  rises, else the published height. */
export function keyboardColumnHeight(
  state: { height: number; motion: ViewportMotion | null; interactive: boolean },
  fullHeight: number
): number {
  if (state.interactive) return fullHeight;
  const m = state.motion;
  return m && m.to < m.from ? m.from : state.height;
}
