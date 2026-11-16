// Home groups (K2 0.46.13): the order a group's rows show in. Ported from
// desktop `src/renderer/lib/home-row-order.ts` (queue-0.46.13).
//
//   1. Pinned rows first, in pin order (at most MAX_PINS per group,
//      counted across agents, people and channels alike).
//   2. Then the rest: in the group's manual order, or, with the group's
//      "Most recent at the top" on, newest send first (`lastMessagedAt`,
//      stamped only by the person's own sends), the rows never sent to
//      after them in manual order.
//
// Pure, over the Homes store's shapes. Pins and sends sync on the row,
// "Most recent at the top" on the group (homes_sync, migration 0305).
// Desktop's ⌘1–9 shortcuts have no phone equivalent.

import { assignOrders, compareOrder } from "../fracIndex";

/** The most pinned rows one group may hold (the daemon's `MAX_PINS`). */
export const MAX_PINS = 9;

/** The pin menu's reason at the limit (desktop copy). */
export const PINS_FULL_TEXT = "Up to 9 pins. Unpin one first.";

export interface RowLike {
  address: string;
  pinOrder?: string | null;
  lastMessagedAt?: number | null;
}

export interface HomeLike<R extends RowLike> {
  rows: readonly R[];
  recentFirst?: boolean;
}

export function isPinned(r: RowLike): boolean {
  return typeof r.pinOrder === "string" && r.pinOrder.length > 0;
}

/** The pinned rows, in pin order. */
export function pinnedRows<R extends RowLike>(home: HomeLike<R>): R[] {
  return home.rows
    .filter(isPinned)
    .sort((a, b) => compareOrder(a.pinOrder as string, b.pinOrder as string) || compareOrder(a.address, b.address));
}

/** The rows that are not pinned: manual order, or newest send first. */
export function unpinnedRows<R extends RowLike>(home: HomeLike<R>): R[] {
  const rest = home.rows.filter((r) => !isPinned(r));
  if (!home.recentFirst) return rest;
  // Array.prototype.sort is stable: equal stamps (and no stamp) keep manual order.
  return rest.sort((a, b) => (b.lastMessagedAt ?? 0) - (a.lastMessagedAt ?? 0));
}

/** Every row, in the order the list shows them. */
export function displayRows<R extends RowLike>(home: HomeLike<R>): R[] {
  return [...pinnedRows(home), ...unpinnedRows(home)];
}

/**
 * A Rearrange drop, in shown positions: the row at `from` dropped to land
 * at `to`. Pinned rows move among the pins; unpinned rows move among the
 * unpinned ones in manual order (with "Most recent at the top" on, their
 * order is automatic, so nothing moves). Returns the new pin order, or the
 * new full manual order of the group's rows, or null.
 */
export function planRowDrop<R extends RowLike>(
  home: HomeLike<R>,
  from: number,
  to: number
): { pins: string[] } | { rows: string[] } | null {
  const pins = pinnedRows(home).map((r) => r.address);
  const shown = displayRows(home);
  if (from < 0 || from >= shown.length || from === to) return null;
  if (from < pins.length) {
    const target = Math.min(Math.max(to, 0), pins.length - 1);
    if (target === from) return null;
    const next = [...pins];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    return { pins: next };
  }
  if (home.recentFirst) return null;
  const unpinned = shown.slice(pins.length).map((r) => r.address);
  const u = from - pins.length;
  const v = Math.min(Math.max(to - pins.length, 0), unpinned.length - 1);
  if (u === v) return null;
  const reordered = [...unpinned];
  const [moved] = reordered.splice(u, 1);
  reordered.splice(v, 0, moved);
  // The unpinned rows take their new order in the slots they already hold
  // in the group's manual order; pinned rows keep theirs.
  let k = 0;
  return { rows: home.rows.map((r) => (isPinned(r) ? r.address : reordered[k++])) };
}

/** Pin keys for `addresses` in this order, keeping every key that is
 *  still in order (`fracIndex`'s assignOrders). */
export function pinKeys(addresses: readonly string[], current: (address: string) => string | null): Map<string, string> {
  const keys = assignOrders(addresses.length, (i) => current(addresses[i]));
  return new Map(addresses.map((a, i) => [a, keys[i]]));
}
