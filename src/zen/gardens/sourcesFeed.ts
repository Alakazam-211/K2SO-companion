import type { VerbAnswer, VerbError } from "./frameHost";

// One frame's `sources.subscribe` (contract rev 2 §E, §G). The first read goes
// through the door, so a refusal reaches the widget. After that each
// `sources_changed` re-reads `remote/sources-changes` with our own `since`, at
// most once per 2 s, and pushes what moved. A frame out of sight holds its
// re-reads and catches up once when it's back.

export const SOURCES_READ_GAP_MS = 2_000;
/** After a failed read, with no event to prompt the next one. */
export const SOURCES_RETRY_MS = 30_000;

export type SourceView = Record<string, unknown> & { address?: unknown };
export type SourcesChanges = { rev: number; full: boolean; changed: SourceView[]; removed: string[] };

export interface SourcesFeedOptions {
  /** `sources.read` through the door. */
  readView(address: string): Promise<VerbAnswer>;
  readChanges(since: number): Promise<VerbAnswer>;
  /** Start listening for events (`sources_changed`, back in the foreground). */
  watch(onChange: () => void): () => void;
  visible: boolean;
}

export interface SourcesFeed {
  subscribe(address: string, push: (view: unknown) => void, fail: (error: VerbError) => void): () => void;
  setVisible(visible: boolean): void;
}

type Sub = {
  address: string;
  push(view: unknown): void;
  fail(error: VerbError): void;
  /** Its first read answered. */
  started: boolean;
  /** The last view it was given, as JSON. */
  sent: string | null;
};

/** Worth keeping the subscription: the next event tries again. */
const RETRY_LATER = new Set(["unreachable", "failed", "rate_limited"]);
/** The read failed: what the widget holds may be out of date. */
const GREY = new Set(["unreachable", "failed"]);

export function createSourcesFeed(opts: SourcesFeedOptions, now: () => number = Date.now): SourcesFeed {
  const subs = new Set<Sub>();
  const views = new Map<string, SourceView>();
  let visible = opts.visible;
  let since = 0;
  let due = false;
  let greyed = false;
  let reading = false;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unwatch: (() => void) | null = null;

  function send(sub: Sub, view: unknown): void {
    const json = JSON.stringify(view);
    if (json === sub.sent) return;
    sub.sent = json;
    sub.push(view);
  }

  function end(sub: Sub, error: VerbError): void {
    if (!subs.delete(sub)) return;
    sub.fail(error);
    idleIfEmpty();
  }

  function idleIfEmpty(): void {
    if (subs.size > 0) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    due = false;
    unwatch?.();
    unwatch = null;
  }

  function grey(): void {
    greyed = true;
    for (const sub of subs) {
      const last = views.get(sub.address);
      if (last) send(sub, { ...last, phase: "stale", display: "stale", reach: "unreachable" });
    }
  }

  async function firstRead(sub: Sub): Promise<void> {
    const answer = await opts.readView(sub.address);
    if (!subs.has(sub)) return;
    if (answer.ok) {
      sub.started = true;
      views.set(sub.address, answer.value as SourceView);
      send(sub, answer.value);
    } else if (!RETRY_LATER.has(answer.error.code)) {
      end(sub, { ...answer.error, room: answer.error.room ?? sub.address });
    }
  }

  function apply(changes: SourcesChanges): void {
    since = changes.rev;
    const seen = new Set<string>();
    for (const view of changes.changed) {
      if (typeof view.address !== "string") continue;
      seen.add(view.address);
      views.set(view.address, view);
    }
    const gone = new Set(changes.removed);
    for (const sub of [...subs]) {
      if (!sub.started) continue;
      if (gone.has(sub.address) || (changes.full && !seen.has(sub.address))) {
        views.delete(sub.address);
        end(sub, { code: "removed", message: "This source was removed.", room: sub.address });
      } else if (seen.has(sub.address) || greyed) {
        // Greyed and unchanged since: the server is back, so its last view stands.
        send(sub, views.get(sub.address));
      }
    }
    greyed = false;
  }

  async function read(): Promise<void> {
    reading = true;
    lastReadAt = now();
    due = false;
    let retry = false;
    await Promise.all([...subs].filter((s) => !s.started).map(firstRead));
    if (subs.size > 0) {
      const answer = await opts.readChanges(since);
      if (subs.size > 0) {
        if (answer.ok) apply(answer.value as SourcesChanges);
        else if (RETRY_LATER.has(answer.error.code)) {
          retry = true;
          if (GREY.has(answer.error.code)) grey();
        } else for (const sub of [...subs]) end(sub, answer.error);
      }
    }
    reading = false;
    if (retry && subs.size > 0 && !due) {
      due = true;
      timer = setTimeout(() => {
        timer = null;
        request();
      }, SOURCES_RETRY_MS);
    } else if (due) request();
  }

  /** Read as soon as the rules allow. */
  function request(): void {
    due = true;
    if (!visible || reading || timer !== null || subs.size === 0) return;
    const wait = lastReadAt + SOURCES_READ_GAP_MS - now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (due) request();
      }, wait);
      return;
    }
    void read();
  }

  return {
    subscribe(address, push, fail) {
      const sub: Sub = { address, push, fail, started: false, sent: null };
      subs.add(sub);
      unwatch ??= opts.watch(request);
      void firstRead(sub);
      return () => {
        subs.delete(sub);
        idleIfEmpty();
      };
    },
    setVisible(next) {
      const back = next && !visible;
      visible = next;
      if (back && due) request();
    },
  };
}
