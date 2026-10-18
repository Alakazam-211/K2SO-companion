import { useEffect } from "react";
import { getThread } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { scopeFor, type ServerScope } from "../api/scope";
import { fetchProjectGroupDelta, fetchThreadDelta } from "../api/threadDelta";
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
import type { RowRef } from "./unread";
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
};

export interface Prefetcher {
  request(targets: PrefetchTarget[]): void;
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

  function pump(): void {
    while (running.size < concurrency && queue.length) {
      const next = queue.shift();
      if (!next) break;
      if (!deps.foreground()) {
        queue.length = 0;
        return;
      }
      running.add(next.key);
      void run(next.key, next.t).finally(() => {
        running.delete(next.key);
        pump();
      });
    }
  }

  return {
    request(targets) {
      if (!deps.foreground()) return;
      const open = deps.openKey();
      for (const t of targets) {
        const key = prefetchKey(t);
        if (!key || key === open || running.has(key) || queue.some((q) => q.key === key)) continue;
        if (!due(key)) continue;
        if (deps.isDown(t.serverId) || !usable(deps.scopeOf(t.serverId))) continue;
        queue.push({ key, t });
      }
      pump();
    },
    stop() {
      queue.length = 0;
    },
    inFlight: () => running.size,
    queued: () => queue.length,
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
  }));
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
