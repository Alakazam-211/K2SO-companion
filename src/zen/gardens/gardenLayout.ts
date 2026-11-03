import type { GardenPageBody, GardenRun, GardenWidget, PhoneHeight } from "./gardensApi";

// A Garden on a phone. Its mobile version when it has one (`page.phone`, K2
// 0.46.8, contract rev 2 §A; Rosson: "we prioritize those"). Otherwise its
// desktop layout (§7): one column per screen, on any server. Read from each
// page, so a Garden moves to its mobile version the moment one exists.
//
// Height rule (rev 2 §A.4): one widget fills its screen; several stack and
// the page scrolls.

export const STACK_START = 0.6;
export const STACK_MIN_PX = 160;
export const STACK_MAX_SCREENS = 3;

export type GardenSlot = { widget: GardenWidget; run: GardenRun; reason?: string; height?: PhoneHeight; frameVersion?: string };
export type GardenScreen = {
  index: number;
  label: string;
  minWidth: number;
  /** A full canvas keeps every finger: no swipe while it's on screen. */
  full: boolean;
  slots: GardenSlot[];
};

export function screensOf(body: GardenPageBody): GardenScreen[] {
  const runOf = new Map(body.remote.widgets.map((w) => [w.id, w]));
  const slotOf = (widget: GardenWidget, height?: PhoneHeight): GardenSlot => {
    const row = runOf.get(widget.id);
    return { widget, run: row?.run ?? "placeholder", reason: row?.reason, height, frameVersion: row?.frameVersion };
  };
  const phone = body.page.phone?.screens;
  if (phone?.length) {
    const byId = new Map(body.page.widgets.map((w) => [w.id, w]));
    return phone
      .map((screen, index) => ({
        index,
        label: screen.label ?? `Screen ${index + 1}`,
        minWidth: 0,
        full: screen.canvas === "full",
        slots: screen.widgets.flatMap((entry) => {
          const widget = byId.get(entry.id);
          return widget ? [slotOf(widget, entry.height)] : [];
        }),
      }))
      .filter((s) => s.slots.length > 0);
  }
  const columns = body.page.layout.columns ?? [];
  const count = Math.max(columns.length, 1);
  const full = body.page.layout.canvas === "full";
  const screens: GardenScreen[] = Array.from({ length: count }, (_, index) => ({
    index,
    label: columns[index]?.label ?? `Column ${index + 1}`,
    minWidth: columns[index]?.["min-width"] ?? 0,
    full,
    slots: [],
  }));
  for (const widget of body.page.widgets) {
    screens[Math.min(widget.column ?? 0, count - 1)].slots.push(slotOf(widget));
  }
  return screens.filter((s) => s.slots.length > 0);
}

/** A slot's CSS height on its screen. `reported` is the frame's own
 *  `{size}`; a px height ignores it. */
export function slotHeight(
  slot: Pick<GardenSlot, "height">,
  alone: boolean,
  reported: number | undefined,
  visibleHeight: number
): number | string {
  const want = slot.height ?? (alone ? "fill" : "auto");
  if (want === "fill") return "100%";
  return stackHeight(want === "auto" ? reported : want, visibleHeight);
}

/** A stacked frame's height: what it reported, within the rule's limits. */
export function stackHeight(reported: number | undefined, visibleHeight: number): number {
  if (reported === undefined || !Number.isFinite(reported)) {
    return Math.max(STACK_MIN_PX, Math.round(visibleHeight * STACK_START));
  }
  const height = Math.max(STACK_MIN_PX, Math.round(reported));
  // Not measured yet: no upper limit to apply.
  return visibleHeight > 0 ? Math.min(height, Math.round(visibleHeight * STACK_MAX_SCREENS)) : height;
}

/** Which screens run: the one on screen and its neighbours. */
export function shouldRun(screen: number, current: number): boolean {
  return Math.abs(screen - current) <= 1;
}
