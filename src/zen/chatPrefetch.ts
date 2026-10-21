import { useEffect } from "react";
import { getThread } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { onBootInfo, scopeFor, type ServerScope } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { fetchProjectGroupDelta, fetchThreadDelta } from "../api/threadDelta";
import { catchupSupported } from "../api/threadCatchup";
import { catchUpServer } from "./chatCatchup";
import { chatCache, type ChatCache } from "./chatCache";
import { pool } from "./multi/pool";
import { serverDown } from "./multi/serverHealth";
import { threadRoomKey } from "./outbox";
import {
  applyGroupRead,
  applyThreadRead,
  fetchGroupRead,
  fetchThreadRead,
  type ChatRead,
  type ReadDeps,
} from "./chatRevalidate";
import { addrKey, type AddrMap, type RowRef, type ServerUnread } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { parseLastAtKey } from "./lastAtFetch";
import { useZenStore } from "./zenStore";
import { zenScope } from "./zenScope";

// Chat prefetch: while the list is on screen and the app is in the
// foreground, warm the chat cache for the chats most likely to be opened
// next — the top Home rows and any row with something unread — so the tap
// paints from cache. Each read runs on the row's OWN server scope, at most
// `PREFETCH_CONCURRENCY` at a time, never on a server that is down, at
// most once per chat per `PREFETCH_MIN_GAP_MS`; backgrounding the app
// drops what is queued. Reads like an open does (`chatRevalidate`): a
// delta (`thread-delta-v1`) when the server lists it and the cache has a
// cursor, otherwise the newest page.
//
// Unread-driven (`installUnreadPrefetch`): whenever a server's unread state
// says a chat changed (its `lastSeq`, unread or waiting count went up — a
// frame or a summary re-read), that chat is prefetched at once (the gap
// above does not apply; the concurrency cap, foreground-only and
// never-the-open-chat rules do), whether the list is on screen or the
// reader is inside another chat. Returning to it then paints fresh.

export const PREFETCH_TOP = 8;
export const PREFETCH_CONCURRENCY = 2;
export const PREFETCH_MIN_GAP_MS = 120_000;

export type PrefetchTarget = { serverId: string; ref: RowRef };

export function prefetchKey(t: PrefetchTarget): string | null {
  if (!t.serverId) return null;
  if (t.ref.kind === "project") return t.ref.groupId ? threadRoomKey(t.serverId, t.ref.groupId, null) : null;
  const addr = (t.ref.addr || "").trim();
  return addr ? threadRoomKey(t.serverId, null, addr) : null;
}

/** The list's prefetch set: the first `top` Home rows, then every other
 *  row with something unread (in the order given), each chat once. */
export function prefetchTargets(
  home: PrefetchTarget[],
  others: PrefetchTarget[],
  hasUnread: (t: PrefetchTarget) => boolean,
  top = PREFETCH_TOP
): PrefetchTarget[] {
  const out: PrefetchTarget[] = [];
  const seen = new Set<string>();
  const add = (t: PrefetchTarget) => {
    const k = prefetchKey(t);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  home.slice(0, top).forEach(add);
  for (const t of [...home.slice(top), ...others]) if (hasUnread(t)) add(t);
  return out;
}

export type PrefetchDeps = {
  now: () => number;
  scopeOf: (serverId: string) => ServerScope | null;
  isDown: (serverId: string) => boolean;
  foreground: () => boolean;
  /** The room key of the chat open right now (its own reads own it). */
  openKey: () => string | null;
  cache: () => ChatCache;
  getThread: typeof getThread;
  fetchThreadDelta: typeof fetchThreadDelta;
  fetchProjectGroupMessages: typeof fetchProjectGroupMessages;
  fetchProjectGroupDelta: typeof fetchProjectGroupDelta;
  concurrency?: number;
  minGapMs?: number;
  /** K2 0.46.3 `inbox-catchup-v1`: a server's due chats in ONE call
   *  (`catchUpServer`); returns the ones left for the per-chat read. */
  catchup?: {
    supported: (serverId: string) => boolean;
    run: (serverId: string, targets: PrefetchTarget[]) => Promise<PrefetchTarget[]>;
  };
};

export interface Prefetcher {
  /** `force`: the chat is known to have changed — skip the min gap (a read
   *  already running for it runs once more after it). */
  request(targets: PrefetchTarget[], opts?: { force?: boolean }): void;
  /** Drop what is queued (the app went to the background). */
  stop(): void;
  /** Tests: what ran / is queued. */
  inFlight(): number;
  queued(): number;
}

function usable(scope: ServerScope | null): scope is ServerScope {
  if (!scope) return false;
  try {
    return !!scope.token();
  } catch {
    return false;
  }
}

export function createPrefetcher(deps: PrefetchDeps): Prefetcher {
  const concurrency = deps.concurrency ?? PREFETCH_CONCURRENCY;
  const minGap = deps.minGapMs ?? PREFETCH_MIN_GAP_MS;
  const lastRun = new Map<string, number>();
  const queue: { key: string; t: PrefetchTarget }[] = [];
  const running = new Set<string>();
  /** Forced while running: read again once it is done. */
  const again = new Map<string, PrefetchTarget>();
  /** Catch-up: per server, the chats waiting for its one call, and the
   *  servers (and chat keys) whose call is running. */
  const batches = new Map<string, Map<string, PrefetchTarget>>();
  const batchServers = new Set<string>();
  const batchKeys = new Set<string>();
  const busy = () => running.size + batchServers.size;

  const due = (key: string) => {
    const at = lastRun.get(key);
    return at == null || deps.now() - at >= minGap;
  };

  const readDeps: ReadDeps = {
    getThread: (...a) => deps.getThread(...a),
    fetchThreadDelta: (...a) => deps.fetchThreadDelta(...a),
    fetchProjectGroupMessages: (...a) => deps.fetchProjectGroupMessages(...a),
    fetchProjectGroupDelta: (...a) => deps.fetchProjectGroupDelta(...a),
  };

  async function run(key: string, t: PrefetchTarget): Promise<void> {
    lastRun.set(key, deps.now());
    const scope = deps.scopeOf(t.serverId);
    if (!usable(scope) || deps.isDown(t.serverId) || !deps.foreground()) return;
    const cached = (await deps.cache().read(key))?.entry ?? null;
    let read: ChatRead;
    try {
      read =
        t.ref.kind === "project"
          ? await fetchGroupRead(scope, t.ref.groupId, cached, readDeps)
          : await fetchThreadRead(scope, (t.ref.addr || "").trim(), cached, readDeps);
    } catch {
      return;
    }
    // Opened meanwhile (its own read is the one that counts), or signed
    // out / removed meanwhile (nothing may come back).
    if (deps.openKey() === key || !usable(deps.scopeOf(t.serverId))) return;
    if (!read.ok) {
      if (read.gone) deps.cache().forget(key); // access or chat gone
      return;
    }
    const base = read.mode === "reset" ? [] : cached?.messages ?? [];
    const messages =
      t.ref.kind === "project"
        ? applyGroupRead(base, read)
        : applyThreadRead(base, read, { conversationId: cached?.conversationId ?? null });
    if (read.mode === "reset") deps.cache().forget(key);
    deps.cache().remember({
      key,
      serverId: t.serverId,
      messages,
      conversationId: read.conversationId ?? cached?.conversationId ?? null,
      hasMore: read.hasMore ?? cached?.hasMore ?? false,
    });
  }

  function runBatch(serverId: string): void {
    const set = batches.get(serverId);
    batches.delete(serverId);
    if (!set?.size || !deps.catchup) return;
    const targets = [...set.values()];
    batchServers.add(serverId);
    for (const k of set.keys()) {
      batchKeys.add(k);
      lastRun.set(k, deps.now());
    }
    void deps.catchup
      .run(serverId, targets)
      .catch(() => targets)
      .then((left) => {
        // Left over (an uncached project chat, a moved conversation, the
        // call failed): the per-chat read, as before.
        if (!deps.foreground()) return;
        const open = deps.openKey();
        for (const t of left) {
          const key = prefetchKey(t);
          if (!key || key === open || running.has(key) || queue.some((q) => q.key === key)) continue;
          queue.push({ key, t });
        }
      })
      .finally(() => {
        batchServers.delete(serverId);
        for (const k of set.keys()) batchKeys.delete(k);
        pump();
      });
  }

  function pump(): void {
    for (const serverId of [...batches.keys()]) {
      if (busy() >= concurrency) break;
      if (batchServers.has(serverId)) continue;
      if (!deps.foreground()) {
        batches.clear();
        break;
      }
      runBatch(serverId);
    }
    while (busy() < concurrency && queue.length) {
      const next = queue.shift();
      if (!next) break;
      if (!deps.foreground()) {
        queue.length = 0;
        return;
      }
      running.add(next.key);
      void run(next.key, next.t).finally(() => {
        running.delete(next.key);
        const re = again.get(next.key);
        if (re) {
          again.delete(next.key);
          if (deps.foreground() && deps.openKey() !== next.key) queue.push({ key: next.key, t: re });
        }
        pump();
      });
    }
  }

  return {
    request(targets, opts = {}) {
      if (!deps.foreground()) return;
      const open = deps.openKey();
      for (const t of targets) {
        const key = prefetchKey(t);
        if (!key || key === open) continue;
        if (running.has(key)) {
          if (opts.force) again.set(key, t);
          continue;
        }
        if (queue.some((q) => q.key === key)) continue;
        if (batchKeys.has(key) && !opts.force) continue;
        if (!opts.force && !due(key)) continue;
        if (deps.isDown(t.serverId) || !usable(deps.scopeOf(t.serverId))) continue;
        if (deps.catchup?.supported(t.serverId)) {
          let set = batches.get(t.serverId);
          if (!set) batches.set(t.serverId, (set = new Map()));
          set.set(key, t);
          continue;
        }
        queue.push({ key, t });
      }
      pump();
    },
    stop() {
      queue.length = 0;
      again.clear();
      batches.clear();
    },
    inFlight: () => running.size + batchServers.size,
    queued: () => queue.length + [...batches.values()].reduce((n, m) => n + m.size, 0),
  };
}

function scopeOrNull(serverId: string): ServerScope | null {
  try {
    return scopeFor(serverId);
  } catch {
    return null;
  }
}

function openRoomKey(): string | null {
  const z = useZenStore.getState();
  if (z.screen !== "thread") return null;
  const groupId = (z.threadGroupId || "").trim();
  const addr = (z.threadAddr || "").trim();
  if (!groupId && !addr) return null;
  return threadRoomKey(zenScope().id, groupId || null, groupId ? null : addr);
}

let shared: Prefetcher | null = null;

/** The app's prefetcher. */
export function chatPrefetcher(): Prefetcher {
  return (shared ??= createPrefetcher({
    now: () => Date.now(),
    scopeOf: scopeOrNull,
    isDown: (id) => serverDown(id, pool.entry(id)),
    foreground: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    openKey: openRoomKey,
    cache: chatCache,
    getThread,
    fetchThreadDelta,
    fetchProjectGroupMessages,
    fetchProjectGroupDelta,
    catchup: {
      supported: (id) => {
        const scope = scopeOrNull(id);
        return !!scope && catchupSupported(scope);
      },
      run: (id, targets) => {
        const scope = scopeOrNull(id);
        if (!scope) return Promise.resolve(targets);
        return catchUpServer(scope, targets, {
          cache: chatCache,
          openKey: openRoomKey,
          usable: () => usable(scopeOrNull(id)),
        });
      },
    },
  }));
}

/** Chats whose unread state moved between `prev` and `next` (one
 *  server): `lastSeq`, unread or waiting went up, or a chat newly has
 *  something. Nothing on the summary's first load (the list's own prefetch
 *  covers what is unread then). A Thread is found by its conversation id
 *  through `addrs` (`addrOf` gives the addr's own spelling). */
export function unreadMovedTargets(
  serverId: string,
  prev: ServerUnread | undefined,
  next: ServerUnread | undefined,
  addrs: AddrMap | undefined,
  addrOf: (lowerAddr: string) => string = (a) => a
): PrefetchTarget[] {
  if (!serverId || !prev || !prev.loaded || !next || prev === next) return [];
  const out: PrefetchTarget[] = [];
  let byConv: Map<string, string> | null = null;
  for (const [key, e] of Object.entries(next.byKey)) {
    const b = prev.byKey[key];
    const moved = b
      ? e.lastSeq > b.lastSeq || e.unread > b.unread || e.waiting > b.waiting
      : e.unread > 0 || e.waiting > 0;
    if (!moved) continue;
    if (e.kind === "project") {
      out.push({ serverId, ref: { kind: "project", groupId: e.id } });
      continue;
    }
    byConv ??= new Map(Object.entries(addrs ?? {}).map(([a, c]) => [c, a]));
    const lower = byConv.get(e.id);
    if (lower) out.push({ serverId, ref: { kind: "thread", addr: addrOf(lower), conversationId: e.id } });
  }
  return out;
}

/** The addr as the app spells it (the list's row keys), from its
 *  lowercased form. */
function spelledAddr(serverId: string, lower: string): string {
  const z = useZenStore.getState();
  for (const k of Object.keys(z.previewByKey)) {
    const p = parseLastAtKey(k);
    if (p && p.serverId === serverId && p.kind === "thread" && addrKey(p.id) === lower) return p.id;
  }
  if (zenScope().id === serverId) {
    const a = z.agents.find((x) => x.addr && addrKey(x.addr) === lower);
    if (a?.addr) return a.addr;
  }
  return lower;
}

/** Prefetch every chat whose unread state moves (any server, any screen).
 *  Returns the unsubscribe. */
export function installUnreadPrefetch(prefetcher: () => Prefetcher = chatPrefetcher): () => void {
  return useUnreadStore.subscribe((st, prev) => {
    if (st.servers === prev.servers) return;
    const targets: PrefetchTarget[] = [];
    for (const id of Object.keys(st.servers)) {
      targets.push(
        ...unreadMovedTargets(id, prev.servers[id], st.servers[id], st.addrs[id], (a) => spelledAddr(id, a))
      );
    }
    if (targets.length) prefetcher().request(targets, { force: true });
  });
}

/** Mounted once (the Zen page): unread-driven prefetch while it is up. */
export function useUnreadPrefetch(): void {
  useEffect(() => installUnreadPrefetch(), []);
}

// ─── Foreground catch-up (K2 0.46.3 `inbox-catchup-v1`) ───
//
// On launch and on every return to the foreground, every chat cached for a
// server that offers catch-up is brought up to date in one call per server
// (the prefetcher batches them: `catchUpServer`). Servers without the
// feature keep the list-driven prefetch above. At most once per server per
// FOREGROUND_CATCHUP_GAP_MS; a server whose boot-status arrives later in
// the same foreground is caught up then.

export const FOREGROUND_CATCHUP_GAP_MS = 30_000;

/** A chat cache key back to its target (`<serverId>|t:<addr>` /
 *  `<serverId>|g:<groupId>`). */
export function targetOfKey(key: string): PrefetchTarget | null {
  const i = key.indexOf("|");
  if (i <= 0) return null;
  const serverId = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (rest.startsWith("g:") && rest.length > 2) return { serverId, ref: { kind: "project", groupId: rest.slice(2) } };
  if (rest.startsWith("t:") && rest.length > 2) return { serverId, ref: { kind: "thread", addr: rest.slice(2) } };
  return null;
}

export type ForegroundCatchupDeps = {
  prefetcher: () => Prefetcher;
  cache: () => ChatCache;
  servers: () => string[];
  supported: (serverId: string) => boolean;
  now: () => number;
};

/** Catch up every cached chat of `serverIds` that are due. */
export async function catchUpCached(
  serverIds: readonly string[],
  last: Map<string, number>,
  deps: ForegroundCatchupDeps
): Promise<void> {
  for (const id of serverIds) {
    if (!deps.supported(id)) continue;
    const at = last.get(id);
    if (at != null && deps.now() - at < FOREGROUND_CATCHUP_GAP_MS) continue;
    last.set(id, deps.now());
    const keys = await deps.cache().keysFor(id);
    const targets = keys.map(targetOfKey).filter((t): t is PrefetchTarget => !!t);
    if (targets.length) deps.prefetcher().request(targets, { force: true });
  }
}

/** Launch / foreground catch-up. Returns the unsubscribe. */
export function installForegroundCatchup(
  deps: ForegroundCatchupDeps = {
    prefetcher: chatPrefetcher,
    cache: chatCache,
    servers: () => {
      const st = useServersStore.getState();
      return st.servers.filter((x) => st.tokens[x.id]).map((x) => x.id);
    },
    supported: (id) => {
      const scope = scopeOrNull(id);
      return !!scope && catchupSupported(scope);
    },
    now: () => Date.now(),
  }
): () => void {
  const last = new Map<string, number>();
  /** Caught up during this stay in the foreground (a boot-status read —
   *  the pool's, every 30 s — must not turn into polling). */
  const thisVisit = new Set<string>();
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const run = (ids: string[]) => {
    const due = ids.filter((id) => !thisVisit.has(id) && deps.supported(id));
    for (const id of due) thisVisit.add(id);
    if (due.length) void catchUpCached(due, last, deps);
  };
  if (visible()) run(deps.servers());
  const onVis = () => {
    if (!visible()) {
      thisVisit.clear();
      return;
    }
    run(deps.servers());
  };
  document.addEventListener("visibilitychange", onVis);
  // Boot-status (and so the feature) may arrive after the app came up.
  const off = onBootInfo((id) => {
    if (visible() && deps.servers().includes(id)) run([id]);
  });
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    off();
  };
}

/** Mounted once (the Zen page). */
export function useForegroundCatchup(): void {
  useEffect(() => installForegroundCatchup(), []);
}

/** Tests only. */
export function resetChatPrefetcherForTests(p: Prefetcher | null = null): void {
  shared = p;
}

/** Warm the cache for `targets` while `enabled` (the list on screen); the
 *  app going to the background drops the queue, coming back asks again. */
export function useChatPrefetch(targets: PrefetchTarget[], enabled: boolean): void {
  const sig = enabled ? targets.map((t) => prefetchKey(t) ?? "").join("\n") : "";
  useEffect(() => {
    if (!enabled || !sig) return;
    const p = chatPrefetcher();
    p.request(targets);
    const onVis = () => {
      if (document.visibilityState === "hidden") p.stop();
      else p.request(targets);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // `sig` names the targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sig]);
}
