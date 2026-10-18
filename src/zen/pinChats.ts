export const PIN_HOLD_MS = 280;
export const PIN_LIFT_PX = 14;
/** A still hold on a pin avatar this long opens its menu (Open / Unpin).
 *  Pins lift on movement only, so the hold and the drag never race. */
export const PIN_MENU_MS = 500;
/** The old per-device pin list. Pins now live on the server (per
 *  workspace, `projects.pinned`); the old key is dropped, not migrated. */
export const LEGACY_PIN_STORAGE_KEY = "k2-zen-pinned-ids";

export function clearLegacyPinStore(): void {
  try {
    localStorage.removeItem(LEGACY_PIN_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

/** Place `id` before `beforeId`, or at the end when `beforeId` is null. */
export function insertPinned(
  ids: string[],
  id: string,
  beforeId: string | null
): string[] {
  if (!id) return ids;
  const rest = ids.filter((x) => x !== id);
  if (!beforeId) return [...rest, id];
  const i = rest.indexOf(beforeId);
  if (i < 0) return [...rest, id];
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}

/** Pin under the pointer: insert before that pin, or after it (append). */
export function pinBeforeId(
  x: number,
  y: number,
  root: HTMLElement | null
): string | null {
  if (!root) return null;
  const nodes = [
    ...root.querySelectorAll<HTMLElement>("[data-pin-from='pin'][data-pin-id]"),
  ].filter((n) => n.dataset.placeholder !== "1" && n.dataset.pinId);
  if (!nodes.length) return null;
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (!best) return null;
  const r = best.getBoundingClientRect();
  if (x < r.left + r.width / 2) return best.dataset.pinId || null;
  const next = nodes[nodes.indexOf(best) + 1];
  return next?.dataset.pinId || null;
}

export function dropIsPins(
  x: number,
  y: number,
  r: { left: number; right: number; top: number; bottom: number } | null
): boolean {
  if (!r) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom + 12;
}

/** A pinned avatar's cell, measured when a pin lifts. */
export type PinSlot = { id: string; left: number; top: number; width: number; height: number };

/** The pin order while a lifted pin hovers: `dragId` moves to the slot
 *  whose centre is nearest the pointer. Off the grid = the start order. */
export function pinPreviewOrder(
  slots: PinSlot[],
  dragId: string,
  x: number,
  y: number,
  overGrid: boolean
): string[] {
  const ids = slots.map((s) => s.id);
  const from = ids.indexOf(dragId);
  if (from < 0 || !overGrid) return ids;
  let to = from;
  let bestD = Infinity;
  slots.forEach((s, i) => {
    const d = Math.hypot(x - (s.left + s.width / 2), y - (s.top + s.height / 2));
    if (d < bestD) {
      bestD = d;
      to = i;
    }
  });
  const next = ids.filter((id) => id !== dragId);
  next.splice(to, 0, dragId);
  return next;
}

/** How far `id` sits from its own cell in `order` (the cells keep their
 *  measured positions; pins slide between them). */
export function pinSlotOffset(
  slots: PinSlot[],
  order: string[],
  id: string
): { dx: number; dy: number } | null {
  const from = slots.findIndex((s) => s.id === id);
  const to = order.indexOf(id);
  if (from < 0 || to < 0 || from === to) return null;
  return { dx: slots[to].left - slots[from].left, dy: slots[to].top - slots[from].top };
}
