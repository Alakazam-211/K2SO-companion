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
