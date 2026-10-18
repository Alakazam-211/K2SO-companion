// Fractional-index order keys for synced Homes (K2 0.46.1 `homes-sync-v1`).
//
// The "fractional-indexing" algorithm (David Greenspan, "Implementing
// Fractional Indexing"; the npm `fractional-indexing` package), base 62,
// written inline so the phone takes no dependency. Keys compare as plain
// strings (`<`), so two devices that reorder concurrently both produce
// keys the other sorts the same way. Pure.
//
// A key is an "integer part" (a head letter that encodes its length, then
// digits) plus an optional fraction with no trailing zero. `a0` is the
// first key ever handed out.

export const BASE_62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = BASE_62_DIGITS[0];
const SMALLEST_INT = "A" + ZERO.repeat(26);

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error("trailing zero");
  if (b) {
    // Shared prefix: recurse past it.
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? BASE_62_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? BASE_62_DIGITS.indexOf(b[0]) : BASE_62_DIGITS.length;
  if (digitB - digitA > 1) {
    return BASE_62_DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  if (b && b.length > 1) return b.slice(0, 1);
  return BASE_62_DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0])) throw new Error(`invalid integer part: ${int}`);
}

function validateKey(key: string): void {
  if (!key || key === SMALLEST_INT) throw new Error(`invalid order key: ${key}`);
  for (const ch of key) {
    if (BASE_62_DIGITS.indexOf(ch) < 0) throw new Error(`invalid order key: ${key}`);
  }
  const i = integerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === ZERO) throw new Error(`invalid order key: ${key}`);
}

/** True when `key` is a well-formed order key. */
export function isOrderKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  try {
    validateKey(key);
    return true;
  } catch {
    return false;
  }
}

function incrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]) + 1;
    if (d === BASE_62_DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = BASE_62_DIGITS[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digs.push(ZERO);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

function decrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = BASE_62_DIGITS.slice(-1);
    else {
      digs[i] = BASE_62_DIGITS[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return "Z" + BASE_62_DIGITS.slice(-1);
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") digs.push(BASE_62_DIGITS.slice(-1));
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

/** A key strictly between `a` and `b` (either may be null = open end).
 *  Throws on malformed keys or `a >= b`. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateKey(a);
  if (b !== null) validateKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` increasing keys strictly between `a` and `b`. */
export function nKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(c, b);
      out.push(c);
    }
    return out;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(a, c);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...nKeysBetween(a, c, mid), c, ...nKeysBetween(c, b, n - mid - 1)];
}

/** Plain string order (the wire's rule). Missing keys sort last. */
export function compareOrder(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

/**
 * Give every item an order key that matches its array position, changing
 * as few keys as possible: the longest strictly increasing run of valid
 * keys is kept, every other item gets a fresh key between its kept
 * neighbours. Returns the new items and the indexes whose key changed.
 */
export function normalizeOrder<T extends { order?: string }>(
  items: T[]
): { items: T[]; changed: number[] } {
  const n = items.length;
  const keys = items.map((it) => (isOrderKey(it.order) ? it.order : null));
  // Longest strictly increasing subsequence over valid keys (n is small).
  const len = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    const ki = keys[i];
    if (ki === null) continue;
    len[i] = 1;
    for (let j = 0; j < i; j++) {
      const kj = keys[j];
      if (kj !== null && kj < ki && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);

  const out = items.slice();
  const changed: number[] = [];
  let i = 0;
  while (i < n) {
    if (keep.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const lo = i > 0 ? (out[i - 1].order as string) : null;
    const hi = j < n ? (keys[j] as string) : null;
    const fresh = nKeysBetween(lo, hi, j - i);
    for (let k = i; k < j; k++) {
      out[k] = { ...out[k], order: fresh[k - i] };
      changed.push(k);
    }
    i = j;
  }
  return { items: out, changed };
}
