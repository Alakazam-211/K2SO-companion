// Test helper: a left-edge swipe-back (useSwipeBack) on a page, the way a
// finger does it: down at `startX`, a short move right to lock the axis,
// then far right (past the distance threshold in jsdom's 1024px window)
// and up. With real timers the release animation's fallback timer fires
// the page's Back within ~400ms, so assert with `waitFor`.

import { act, fireEvent } from "@testing-library/react";

const at = (x: number) => ({
  touches: [{ clientX: x, clientY: 300 }],
  changedTouches: [{ clientX: x, clientY: 300 }],
});

export function edgeSwipe(el: HTMLElement, startX = 5): void {
  act(() => {
    fireEvent.touchStart(el, at(startX));
    fireEvent.touchMove(el, at(startX + 55));
    fireEvent.touchMove(el, at(startX + 700));
    fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: startX + 700, clientY: 300 }] });
  });
}

/** Whether a touch on `el` at `startX` moving right was taken by the
 *  swipe: true when the move was preventDefault-ed (the hook only does
 *  that once it tracks the finger). Cancels the touch either way. */
export function swipeTakesTouch(el: HTMLElement, startX = 5): boolean {
  let taken = false;
  act(() => {
    fireEvent.touchStart(el, at(startX));
    // fireEvent returns false when a listener called preventDefault.
    taken = !fireEvent.touchMove(el, at(startX + 60));
    // Cancel, not end: a quick lift could count as a flick and go back.
    fireEvent.touchCancel(el, { touches: [], changedTouches: [{ clientX: startX + 60, clientY: 300 }] });
  });
  return taken;
}

/** Let a release animation that would have run (or not) finish. */
export async function settleSwipe(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
}
