// Fractional-index order keys for synced Homes (K2 0.46.1 `homes-sync-v1`).
//
// A port of K2's `src/renderer/lib/fractional-index.ts` (the desktop's
// `orderBetween` / `assignOrders`, which mirrors Rust's
// `k2_core::homes_sync::order_between` byte for byte). The phone must hand
// out the SAME keys as the desktop, so the functions below are that file,
// unchanged in behaviour. Pure.
//
// A key is a string over the 62 digits `0-9A-Za-z` (ASCII order, so plain
// string comparison sorts them), never empty, at most 128 characters, and
// never ending in `0` (so there is always room before it).
//
//   orderBetween(null, null)  → 'V'
//   orderBetween('V', null)   → 'l'      (after)
//   orderBetween(null, 'V')   → 'G'      (before)
//   orderBetween('a', 'b')    → 'aV'     (between neighbours that touch)
//
// Keys this phone handed out before 0.46.1's final contract (`a0`, `a1`,
// `Zz`…) are still plain strings that sort; the ones that end in `0` are
// not valid any more, so `normalizeOrder` re-keys them on the next write.

export const ORDER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ORDER_MAX = 128;

export function isValidOrder(key: string): boolean {
  return key.length > 0 && key.length <= ORDER_MAX && /^[0-9A-Za-z]+$/.test(key) && !key.endsWith("0");
}

/** `isValidOrder` for anything (stored data). */
export function isOrderKey(key: unknown): key is string {
  return typeof key === "string" && isValidOrder(key);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? ORDER_DIGITS.indexOf(a[0]) : 0;
  const db = b !== null && b.length > 0 ? ORDER_DIGITS.indexOf(b[0]) : ORDER_DIGITS.length;
  if (db - da > 1) return ORDER_DIGITS[Math.floor((da + db + 1) / 2)];
  if (b !== null && b.length > 1) return b[0];
  return ORDER_DIGITS[da] + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (null = open end). Throws on an
 *  invalid key or `a >= b` — a caller bug, never user data. */
export function orderBetween(a: string | null, b: string | null): string {
  for (const k of [a, b]) {
    if (k !== null && !isValidOrder(k)) throw new Error(`invalid order key ${JSON.stringify(k)}`);
  }
  if (a !== null && b !== null && a >= b) throw new Error(`order keys out of order: ${a} >= ${b}`);
  return midpoint(a ?? "", b);
}

/** Plain string order (the wire's rule), for `Array.sort`. A missing key
 *  (an item saved before sync) sorts last. */
export function compareOrder(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Indices of the longest strictly increasing run of `keys` (nulls skipped). */
function longestIncreasing(keys: ReadonlyArray<string | null>): Set<number> {
  const tails: number[] = []; // index into keys of the smallest tail for each length
  const prev = new Array<number>(keys.length).fill(-1);
  keys.forEach((k, i) => {
    if (k === null) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tails[mid]] as string) < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<number>();
  let at = tails.length ? tails[tails.length - 1] : -1;
  while (at >= 0) {
    keep.add(at);
    at = prev[at];
  }
  return keep;
}

/**
 * A key for every entry of an ordered list. `known(i)` is the key entry `i`
 * already has (or null). Keys in the longest already-ordered run are kept;
 * every other entry gets a fresh key between its kept neighbours.
 */
export function assignOrders(count: number, known: (i: number) => string | null): string[] {
  const keys = Array.from({ length: count }, (_, i) => {
    const k = known(i);
    return k !== null && isValidOrder(k) ? k : null;
  });
  const keep = longestIncreasing(keys);
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    if (keep.has(i)) {
      out[i] = keys[i] as string;
      continue;
    }
    const before = i > 0 ? out[i - 1] : null;
    let after: string | null = null;
    for (let j = i + 1; j < count; j++) {
      if (keep.has(j)) {
        after = keys[j] as string;
        break;
      }
    }
    out[i] = orderBetween(before, after);
  }
  return out;
}

/**
 * `assignOrders` over items carrying `order`: the items with a key that
 * matches their array position, and the indexes whose key changed (so a
 * single move rewrites a single key).
 */
export function normalizeOrder<T extends { order?: string }>(items: T[]): { items: T[]; changed: number[] } {
  const keys = assignOrders(items.length, (i) => {
    const k = items[i].order;
    return typeof k === "string" ? k : null;
  });
  const changed: number[] = [];
  const out = items.map((it, i) => {
    if (it.order === keys[i]) return it;
    changed.push(i);
    return { ...it, order: keys[i] };
  });
  return { items: out, changed };
}
