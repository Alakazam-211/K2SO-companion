import type { GardenPageBody, GardenRun, GardenWidget } from "./gardensApi";

// A Garden on a phone (§7, the height rule settled with K2 for contract
// rev 2): one column per screen, swiping between them. One widget fills its
// screen. More than one stack and the page scrolls.

export const STACK_START = 0.6;
export const STACK_MIN_PX = 160;
export const STACK_MAX_SCREENS = 3;

export type GardenSlot = { widget: GardenWidget; run: GardenRun; reason?: string };
export type GardenScreen = { index: number; label: string; minWidth: number; slots: GardenSlot[] };

export function screensOf(body: GardenPageBody): GardenScreen[] {
  const runOf = new Map(body.remote.widgets.map((w) => [w.id, w]));
  const columns = body.page.layout.columns ?? [];
  const count = Math.max(columns.length, 1);
  const screens: GardenScreen[] = Array.from({ length: count }, (_, index) => ({
    index,
    label: columns[index]?.label ?? `Column ${index + 1}`,
    minWidth: columns[index]?.["min-width"] ?? 0,
    slots: [],
  }));
  for (const widget of body.page.widgets) {
    const screen = screens[Math.min(widget.column ?? 0, count - 1)];
    const row = runOf.get(widget.id);
    screen.slots.push({ widget, run: row?.run ?? "placeholder", reason: row?.reason });
  }
  return screens.filter((s) => s.slots.length > 0);
}

/** A stacked frame's height: what it reported, within the rule's limits. */
export function stackHeight(reported: number | undefined, visibleHeight: number): number {
  if (reported === undefined || !Number.isFinite(reported)) {
    return Math.max(STACK_MIN_PX, Math.round(visibleHeight * STACK_START));
  }
  return Math.min(Math.max(STACK_MIN_PX, Math.round(reported)), Math.round(visibleHeight * STACK_MAX_SCREENS));
}

/** Which screens run: the one on screen and its neighbours. */
export function shouldRun(screen: number, current: number): boolean {
  return Math.abs(screen - current) <= 1;
}
