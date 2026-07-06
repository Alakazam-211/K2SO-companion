// Pure bottom-anchoring decisions for the chat screens (ProjectChat +
// FeedbackThread) — the standard chat-app rule: stay pinned to the
// newest message through container resizes (keyboard open/close), but
// NEVER yank a user who scrolled up to read history.
//
// IMPORT-SAFE: no DOM / react / tauri imports, so everything here runs
// under a plain Node test runner (scripts/test-bottom-anchor.mjs — the
// test-feedback-pure.mjs idiom).

/** "Near bottom" slop: within this many px of the bottom still counts
 *  as reading the tail — momentum scrolling rarely settles on the exact
 *  last pixel. */
export const NEAR_BOTTOM_SLOP_PX = 40;

/** Whether a scroll container is (near enough to) the bottom. Content
 *  shorter than the container (negative distance) is trivially at the
 *  bottom. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  slopPx: number = NEAR_BOTTOM_SLOP_PX
): boolean {
  return scrollHeight - clientHeight - scrollTop <= slopPx;
}

/** After the overlay column's height changes (useViewportHeight — the
 *  keyboard opening/closing), re-pin to the bottom only when the user
 *  was reading the tail BEFORE the resize and the height actually
 *  changed. */
export function shouldPinAfterResize(
  wasNearBottom: boolean,
  prevHeight: number,
  nextHeight: number
): boolean {
  return wasNearBottom && nextHeight !== prevHeight;
}
