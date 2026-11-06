import type { VerbError } from "./frameHost";

// One frame's `k2.store.subscribe`, a subscription on `store.changes`
// (contract §5.2, §6; the desktop's `zen-custom-store.ts`). Each
// subscription keeps its own cursor in its widget's `data:` space. A read
// pages `store.changes` through the door until `next` is null, so the widget
// never sees half a rev, then pushes `[{key, rev, value, by}]`. The first
// delivery is the whole current state, even when empty. `resync` (the cursor
// is older than K2 keeps) lists everything again and pushes
// `{resync: true, items}`.
//
// Reads come on `garden_data_changed {space, rev}`, a socket re-open and the
// foreground, at most 4 a second per subscription. A frame out of sight
// holds them and catches up once when it's back. Without the app socket a
// slow poll carries it.

export const STORE_READ_GAP_MS = 250;
/** After `rate_limited`, unless K2 says how long (the desktop's 1 s). */
export const STORE_RETRY_MS = 1_000;
/** While the app socket is down, and after `unreachable`: the Tickets poll. */
export const STORE_POLL_MS = 15_000;
/** `store.list` page size for a resync (the desktop's). */
export const STORE_LIST_LIMIT = 500;

/** A door answer, with the refusal fields a subscription needs. */
export type StoreAnswer =
  | { ok: true; value: unknown }
  | { ok: false; error: VerbError; reapedRev?: number; retryAfterSecs?: number };
type StoreRefusal = Extract<StoreAnswer, { ok: false }>;

type Cursor = { since: number; after?: string };
type Change = { key: unknown; rev: unknown; value: unknown; by: unknown };

export interface StoreFeedOptions {
  /** `store.changes` / `store.list` through the door, as the frame's call. */
  call(verb: string, args: unknown[]): Promise<StoreAnswer>;
  /** This widget's space (`data:<widget>`). */
  space: string;
  /** Listen for `garden_data_changed` (`onData`) and re-pulls (`onAll`). */
  watch(onData: (space: string, rev: number) => void, onAll: () => void): () => void;
  /** The app socket is open now. */
  live(): boolean;
  visible: boolean;
}

export interface StoreFeed {
  /** `arg`: a prefix or `{prefix?, since?, from?}`. */
  subscribe(arg: unknown, push: (delivery: unknown) => void, fail: (error: VerbError) => void): (() => void) | VerbError;
  setVisible(visible: boolean): void;
}

type Sub = {
  space: string;
  prefix: string;
  from: string | null;
  cursor: Cursor;
  push(delivery: unknown): void;
  fail(error: VerbError): void;
  live: boolean;
  /** Nothing pushed yet. */
  first: boolean;
  running: boolean;
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastAt: number;
};

/** The space a widget's data lives in (`k2:diary@2` → `data:k2:diary`). */
export function gardenDataSpace(widget: string): string {
  const w = widget.startsWith("k2:") ? widget.split("@")[0] : widget;
  return `data:${w}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const failed = (message: string): StoreRefusal => ({ ok: false, error: { code: "failed", message } });

/** The desktop's argument rules, refused as `failed` as it does. */
function parse(arg: unknown): { prefix: string; from: string | null; cursor: Cursor } | VerbError {
  const out = { prefix: "", from: null as string | null, cursor: { since: 0 } as Cursor };
  if (typeof arg === "string") out.prefix = arg;
  else if (isObj(arg)) {
    if (arg.prefix !== undefined) {
      if (typeof arg.prefix !== "string") return { code: "failed", message: "store.subscribe: prefix is text" };
      out.prefix = arg.prefix;
    }
    if (arg.since !== undefined) {
      if (typeof arg.since !== "number" || !Number.isInteger(arg.since) || arg.since < 0) {
        return { code: "failed", message: "store.subscribe: since is a whole number, 0 or more" };
      }
      out.cursor.since = arg.since;
    }
    // A `next` cursor from `store.changes` resumes inside a rev.
    if (typeof arg.after === "string") out.cursor.after = arg.after;
    if (arg.from !== undefined && arg.from !== null) {
      if (typeof arg.from !== "string" || !arg.from) return { code: "failed", message: "store.subscribe: from is a widget name" };
      out.from = arg.from;
    }
  } else if (arg !== undefined && arg !== null) {
    return { code: "failed", message: "store.subscribe takes a prefix or {prefix, since, from}" };
  }
  return out;
}

export function createStoreFeed(opts: StoreFeedOptions, now: () => number = Date.now): StoreFeed {
  const subs = new Set<Sub>();
  let visible = opts.visible;
  let unwatch: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  function drop(sub: Sub): boolean {
    if (!sub.live) return false;
    sub.live = false;
    subs.delete(sub);
    if (sub.timer !== null) clearTimeout(sub.timer);
    sub.timer = null;
    if (subs.size === 0) {
      unwatch?.();
      unwatch = null;
      if (poll !== null) clearInterval(poll);
      poll = null;
    }
    return true;
  }

  function end(sub: Sub, error: VerbError): void {
    if (drop(sub)) sub.fail(error);
  }

  /** `from` stays the widget's own: K2 checks it against `reads` on every page. */
  function scoped(sub: Sub, args: Record<string, unknown>): unknown[] {
    return [{ ...args, prefix: sub.prefix, ...(sub.from === null ? {} : { from: sub.from }) }];
  }

  /** Every key under the prefix, by pages. */
  async function listAll(sub: Sub): Promise<unknown[] | StoreRefusal> {
    const items: unknown[] = [];
    let after: string | undefined;
    for (;;) {
      const a = await opts.call("store.list", scoped(sub, { ...(after !== undefined ? { after } : {}), limit: STORE_LIST_LIMIT }));
      if (!a.ok) return a;
      if (!isObj(a.value) || !Array.isArray(a.value.items)) return failed("store.list answered without items");
      items.push(...a.value.items);
      const next = a.value.next;
      if (typeof next !== "string" || !next) return items;
      after = next;
    }
  }

  /** List everything again, then read changes from `since`. */
  async function resync(sub: Sub, since: number): Promise<StoreRefusal | null> {
    const items = await listAll(sub);
    if (!sub.live) return null;
    if (!Array.isArray(items)) return items;
    sub.first = false;
    sub.push({ resync: true, items });
    sub.cursor = { since };
    sub.due = true;
    return null;
  }

  /** One read: pages until `next` is null, then one push. */
  async function drain(sub: Sub): Promise<StoreRefusal | null> {
    const rows: Change[] = [];
    let at: Cursor = { ...sub.cursor };
    for (;;) {
      const a = await opts.call(
        "store.changes",
        scoped(sub, { since: at.since, ...(at.after !== undefined ? { after: at.after } : {}) })
      );
      if (!sub.live) return null;
      if (!a.ok) {
        // Replays from the kept history are the same current state.
        return a.error.code === "resync" ? resync(sub, a.reapedRev ?? 0) : a;
      }
      const page = a.value;
      if (!isObj(page) || !Array.isArray(page.items)) return failed("store.changes answered without items");
      const head = typeof page.head === "number" ? page.head : sub.cursor.since;
      // The space went back past our cursor (wiped or restored): the cursor
      // is lost, so start over from what's there now.
      if (head < sub.cursor.since) return resync(sub, head);
      for (const i of page.items) if (isObj(i)) rows.push({ key: i.key, rev: i.rev, value: i.value, by: i.by });
      const next = page.next;
      if (!isObj(next) || typeof next.since !== "number") {
        // Every row up to the head the last page saw is in.
        sub.cursor = { since: Math.max(head, sub.cursor.since) };
        if (rows.length > 0 || sub.first) {
          sub.first = false;
          sub.push(rows);
        }
        return null;
      }
      at = { since: next.since, ...(typeof next.after === "string" ? { after: next.after } : {}) };
    }
  }

  async function pump(sub: Sub): Promise<void> {
    sub.running = true;
    sub.due = false;
    sub.lastAt = now();
    const refusal = await drain(sub);
    sub.running = false;
    if (!sub.live) return;
    if (!refusal) {
      if (sub.due) request(sub);
      return;
    }
    if (refusal.error.code === "rate_limited") {
      sub.due = true;
      const wait = Math.max(STORE_RETRY_MS, (refusal.retryAfterSecs ?? 0) * 1000);
      sub.timer = setTimeout(() => {
        sub.timer = null;
        request(sub);
      }, wait);
      return;
    }
    // No answer from the server (a phone loses it more than a desktop does):
    // the next event, the poll or the foreground reads again.
    if (refusal.error.code === "unreachable") {
      sub.due = true;
      return;
    }
    end(sub, refusal.error);
  }

  /** Read as soon as the rules allow. */
  function request(sub: Sub): void {
    sub.due = true;
    if (!sub.live || !visible || sub.running || sub.timer !== null) return;
    const wait = sub.lastAt + STORE_READ_GAP_MS - now();
    if (wait > 0) {
      sub.timer = setTimeout(() => {
        sub.timer = null;
        if (sub.due) request(sub);
      }, wait);
      return;
    }
    void pump(sub);
  }

  function onData(space: string, rev: number): void {
    for (const sub of [...subs]) {
      if (sub.space !== space) continue;
      if (rev <= sub.cursor.since && !sub.running && !sub.due) continue;
      request(sub);
    }
  }

  function onAll(): void {
    for (const sub of [...subs]) request(sub);
  }

  return {
    subscribe(arg, push, fail) {
      const parsed = parse(arg);
      if (!("prefix" in parsed)) return parsed;
      const sub: Sub = {
        ...parsed,
        space: parsed.from === null ? opts.space : gardenDataSpace(parsed.from),
        push,
        fail,
        live: true,
        first: true,
        running: false,
        due: false,
        timer: null,
        lastAt: Number.NEGATIVE_INFINITY,
      };
      subs.add(sub);
      unwatch ??= opts.watch(onData, onAll);
      poll ??= setInterval(() => {
        const down = !opts.live();
        for (const s of [...subs]) if (down || s.due) request(s);
      }, STORE_POLL_MS);
      // The first read doesn't wait to be seen.
      void pump(sub);
      return () => {
        drop(sub);
      };
    },
    setVisible(next) {
      const back = next && !visible;
      visible = next;
      if (back) for (const sub of [...subs]) if (sub.due) request(sub);
    },
  };
}
