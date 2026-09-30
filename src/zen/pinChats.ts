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
