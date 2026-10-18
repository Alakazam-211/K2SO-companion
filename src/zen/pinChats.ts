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
