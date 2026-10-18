import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { HOLD_MENU_MS } from "../zen/useHoldMenu";

// Test kit for the agent hold menu and Rearrange mode (jsdom has no
// layout: rows get a fake one here).

export const ROW_H = 70;

function rect(top: number, height: number, width = 375): DOMRect {
  return {
    left: 0,
    right: width,
    top,
    bottom: top + height,
    width,
    height,
    x: 0,
    y: top,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

/** Rows that can be dragged, ROW_H tall from y=0, in a tall list. */
export function layoutRows(list: HTMLElement): void {
  list.getBoundingClientRect = () => rect(0, 2000);
  list.querySelectorAll<HTMLElement>("[data-rearrange-key]").forEach((n, i) => {
    n.getBoundingClientRect = () => rect(i * ROW_H, ROW_H);
  });
}

/** Drag grip `from` (in list order) until its row sits at slot `to`. */
export function dragGrip(list: HTMLElement, from: number, to: number): void {
  layoutRows(list);
  const grip = list.querySelectorAll<HTMLElement>("[data-testid='rearrange-grip']")[from];
  if (!grip) throw new Error(`no grip ${from}`);
  const y0 = from * ROW_H + ROW_H / 2;
  const y1 = to * ROW_H + ROW_H / 2 + (to > from ? 5 : to < from ? -5 : 0);
  fireEvent.pointerDown(grip, { clientX: 10, clientY: y0, button: 0, pointerId: 41 });
  fireEvent.pointerMove(grip, { clientX: 10, clientY: (y0 + y1) / 2, pointerId: 41 });
  fireEvent.pointerMove(grip, { clientX: 10, clientY: y1, pointerId: 41 });
  fireEvent.pointerUp(grip, { clientX: 10, clientY: y1, pointerId: 41 });
}

/** Press and hold `el` still until its menu opens, then let go. Needs
 *  fake timers. */
export function holdOpen(el: HTMLElement, pointerId = 31): void {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 200, button: 0, pointerId });
  act(() => {
    vi.advanceTimersByTime(HOLD_MENU_MS + 20);
  });
  fireEvent.pointerUp(el, { clientX: 100, clientY: 200, pointerId });
  // iOS's synthetic click after the hold: eaten by the row.
  fireEvent.click(el);
}

/** A fresh tap (press, release, click) on a menu item or backdrop. */
export function tap(el: HTMLElement, pointerId = 32): void {
  fireEvent.pointerDown(el, { clientX: 0, clientY: 0, button: 0, pointerId });
  fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId });
  fireEvent.click(el);
}

/** The open menu's item labels, in order. */
export function menuLabels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll("[role='menuitem']")].map((n) => (n.textContent || "").trim());
}
