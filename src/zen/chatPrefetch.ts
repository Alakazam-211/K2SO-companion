import { useEffect } from "react";
import { getThread } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { scopeFor, type ServerScope } from "../api/scope";
import {
  DELTA_LIMIT,
  deltaSupported,
  fetchProjectGroupDelta,
  fetchThreadDelta,
} from "../api/threadDelta";
import { chatCache, type ChatCache } from "./chatCache";
import type { CachedChat } from "./chatCacheBackend";
import { pool } from "./multi/pool";
import { serverDown } from "./multi/serverHealth";
import { threadRoomKey } from "./outbox";
import {
  mergeDelta,
  mergeGroupDelta,
  mergeServerPage,
  newestSeq,
} from "./threadCacheMerge";
import { groupMessagesToThread, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import type { RowRef } from "./unread";
import { useZenStore } from "./zenStore";
import { zenScope } from "./zenScope";

// Chat prefetch: while the list is on screen and the app is in the
// foreground, warm the chat cache for the chats most likely to be opened
// next — the top Home rows and any row with something unread — so the tap
// paints from cache. Each read runs on the row's OWN server scope, at most
// `PREFETCH_CONCURRENCY` at a time, never on a server that is down, at
// most once per chat per `PREFETCH_MIN_GAP_MS`; backgrounding the app
// drops what is queued. Uses delta reads (`thread-delta-v1`) when the
// server lists them and the cache has a cursor; otherwise the normal
// newest-page read.

export const PREFETCH_TOP = 8;
export const PREFETCH_CONCURRENCY = 2;
export const PREFETCH_MIN_GAP_MS = 120_000;
const PAGE = 50;

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

  async function readThread(scope: ServerScope, addr: string, cached: CachedChat | null) {
    const username = scope.username();
    const norm = (items: unknown[]) =>
      items
        .map((it) => normaliseThreadItem(it as never, username))
        .filter((m): m is ThreadMessage => !!m);
    const cursor = cached ? newestSeq(cached.messages) : null;
    if (cached && cursor != null && deltaSupported(scope)) {
      const d = await deps.fetchThreadDelta(scope, addr, cursor, DELTA_LIMIT);
      if (d.ok && d.data && !d.data.hasMore) {
        const sameConv = !d.data.conversationId || !cached.conversationId || d.data.conversationId === cached.conversationId;
        if (sameConv) {
          return {
            messages: mergeDelta(cached.messages, norm(d.data.items)),
            conversationId: d.data.conversationId ?? cached.conversationId,
            hasMore: cached.hasMore,
          };
        }
      }
      // More new than one delta, another conversation, or no answer: the
      // newest page.
    }
    const r = await deps.getThread(scope, addr, PAGE);
    if (!r.ok || !r.data || !Array.isArray(r.data.items)) return null;
    const page = norm(r.data.items);
    const conv = (r.data.conversation_id || "").trim() || null;
    const hasMore = !!r.data.has_more;
    const base = cached?.messages ?? [];
    return {
      messages: mergeServerPage(base, page, {
        hasMore,
        sameConversation: !cached?.conversationId || !conv || cached.conversationId === conv,
      }),
      conversationId: conv,
      hasMore,
    };
  }

  async function readGroup(scope: ServerScope, groupId: string, cached: CachedChat | null) {
    const username = scope.username();
    const cursor =
      cached && cached.messages.every((m) => m.readSeq != null) ? newestSeq(cached.messages, "readSeq") : null;
    if (cached && cursor != null && deltaSupported(scope)) {
      const d = await deps.fetchProjectGroupDelta(scope, groupId, cursor, DELTA_LIMIT);
      if (d.ok && d.data && !d.data.hasMore) {
        return {
          messages: mergeGroupDelta(cached.messages, groupMessagesToThread(d.data.items, username)),
          conversationId: null,
          hasMore: cached.hasMore,
        };
      }
    }
    const r = await deps.fetchProjectGroupMessages(scope, groupId, { limit: PAGE });
    if (!r.ok) return null;
    return {
      messages: groupMessagesToThread(r.data?.messages ?? [], username),
      conversationId: null,
      hasMore: !!r.data?.truncated,
    };
  }

  async function run(key: string, t: PrefetchTarget): Promise<void> {
    lastRun.set(key, deps.now());
    const scope = deps.scopeOf(t.serverId);
    if (!usable(scope) || deps.isDown(t.serverId) || !deps.foreground()) return;
    const cached = (await deps.cache().read(key))?.entry ?? null;
    let got: { messages: ThreadMessage[]; conversationId: string | null; hasMore: boolean } | null = null;
    try {
      got =
        t.ref.kind === "project"
          ? await readGroup(scope, t.ref.groupId, cached)
          : await readThread(scope, (t.ref.addr || "").trim(), cached);
    } catch {
      got = null;
    }
    if (!got) return;
    // Opened meanwhile (its own read is the one that counts), or signed
    // out / removed meanwhile (nothing may come back).
    if (deps.openKey() === key || !usable(deps.scopeOf(t.serverId))) return;
    deps.cache().remember({ key, serverId: t.serverId, ...got });
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
