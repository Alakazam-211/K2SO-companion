export const PIN_HOLD_MS = 280;
export const PIN_LIFT_PX = 14;
export const PIN_STORAGE_KEY = "k2-zen-pinned-ids";

export function readPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function writePinnedIds(ids: string[]): void {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* quota / private mode */
  }
}

export function pinId(ids: string[], id: string): string[] {
  if (!id) return ids;
  return [id, ...ids.filter((x) => x !== id)];
}

export function unpinId(ids: string[], id: string): string[] {
  return ids.filter((x) => x !== id);
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

/** Vertical list pan should not start a pin drag. */
export function isListPan(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx) * 1.5;
}
