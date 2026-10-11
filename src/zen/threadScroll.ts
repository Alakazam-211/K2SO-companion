/**
 * Skin-desk thread scroll (K2 Skin Dev `skin/assets/app.js`).
 * Land at the newest on first layout (before paint). When earlier
 * messages prepend, restore against the top-visible MESSAGE element,
 * not scrollHeight arithmetic. overflow-anchor stays off on the scroller.
 */

export type MessageAnchor = { el: HTMLElement; top: number };

export function stickToNewest(scroller: HTMLElement): void {
  scroller.scrollTop = scroller.scrollHeight;
}

export function captureTopMessage(
  scroller: HTMLElement,
  messages: HTMLElement[]
): MessageAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const el of messages) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) return { el, top: r.top };
  }
  return null;
}

export function restoreTopMessage(
  scroller: HTMLElement,
  anchor: MessageAnchor
): void {
  if (!anchor.el.isConnected) return;
  scroller.scrollTop += anchor.el.getBoundingClientRect().top - anchor.top;
}

/** How far (px) the reader is above the newest. */
export function distanceFromBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
}

/** Within this distance of the bottom the Thread follows the newest:
 *  ~120px, but never more than a little under half the visible column
 *  (a short column with the keyboard up). */
export const FOLLOW_PX = 120;
export function followThreshold(clientHeight: number): number {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return FOLLOW_PX;
  return Math.min(FOLLOW_PX, Math.round(clientHeight * 0.45));
}

/** At (or near enough to) the newest to keep following it. */
export function nearNewest(scroller: HTMLElement): boolean {
  return distanceFromBottom(scroller) <= followThreshold(scroller.clientHeight);
}
