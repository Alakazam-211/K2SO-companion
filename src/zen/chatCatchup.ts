// Foreground catch-up (K2 0.46.3 `inbox-catchup-v1`): one
// `POST /cli/thread/catchup` per server brings every cached chat up to
// date, instead of one read per chat. A cached Thread asks `afterSeq` (its
// highest seq, with a conversation id); an uncached Home row asks
// `newest`; a cached project chat asks in `groups`. Each served entry is
// what the per-chat read would have returned, so it goes through the same
// apply as a prefetch (`applyThreadRead` / `applyGroupRead`) and into the
// chat cache. Deferred entries and deltas with more to come ask again
// (up to CATCHUP_MAX_ROUNDS); anything the call can't settle — an uncached
// project chat, a conversation that moved, an address that changed, a
// `resync`, more than the rounds allow — falls back to the per-chat read.
//
// `catchup-unchanged-v1`: each server remembers the last answer's `rev` +
// `instanceId` and which cached Threads it brought fully up to date
// (`CatchupMark`). The first call sends `sinceRev` with just those
// Threads (cached, no open card); `unchanged` settles them with no reads.
// The rest — and project chats, which don't move `rev` — go in the
// normal rounds.

import {
  CATCHUP_LIMIT,
  catchupBody,
  catchupUnchangedSupported,
  postCatchup,
  type CatchupGroupAsk,
  type CatchupResult,
  type CatchupSince,
  type CatchupThreadAsk,
} from "../api/threadCatchup";
import type { ServerScope } from "../api/scope";
import { goneStatus } from "../api/threadDelta";
import type { ChatCache } from "./chatCache";
import {
  applyGroupRead,
  applyThreadRead,
  groupCursor,
  threadCursor,
  type DeltaStep,
  type OkRead,
} from "./chatRevalidate";
import type { PrefetchTarget } from "./chatPrefetch";
import { threadRoomKey } from "./outbox";
import type { CachedChat } from "./chatCacheBackend";
import { groupMessagesToThread, normaliseThreadItem, type ThreadMessage } from "./threadModel";

/** Calls per catch-up (deferred entries and long deltas ask again). */
export const CATCHUP_MAX_ROUNDS = 4;

/** A server's last catch-up position, and the cached Threads that were
 *  fully up to date as of it. */
export type CatchupMark = CatchupSince & { keys: Set<string> };

const marks = new Map<string, CatchupMark>();

/** Tests only. */
export function resetCatchupMarksForTests(): void {
  marks.clear();
}

export type CatchupRunDeps = {
  cache: () => ChatCache;
  post?: typeof postCatchup;
  /** Per server id (default: this module's, kept in memory only). */
  marks?: Map<string, CatchupMark>;
  /** The open chat's key (its own reads own it; never touched here). */
  openKey: () => string | null;
  /** Still signed in to this server? (Nothing may come back otherwise.) */
  usable: () => boolean;
};

type Job = {
  key: string;
  t: PrefetchTarget;
  base: CachedChat | null;
  /** Thread asks go by addr; group asks by groupId. */
  ask: CatchupThreadAsk | CatchupGroupAsk;
  group: boolean;
  steps: DeltaStep[];
  /** Newest page (a `newest` ask). */
  page: ThreadMessage[] | null;
  hasMore: boolean | null;
  conversationId: string | null;
  done: boolean;
  /** Served in full (or `unchanged`): current as of the answer's rev. */
  clean: boolean;
};

/**
 * Catch up `targets` (one server) and write what came back into the chat
 * cache. Returns the targets left for the per-chat read. Never throws.
 */
export async function catchUpServer(
  scope: ServerScope,
  targets: readonly PrefetchTarget[],
  deps: CatchupRunDeps
): Promise<PrefetchTarget[]> {
  const post = deps.post ?? postCatchup;
  const username = scope.username();
  const normThread = (raw: unknown[]) =>
    raw.map((it) => normaliseThreadItem(it as never, username)).filter((m): m is ThreadMessage => !!m);
  const fallback: PrefetchTarget[] = [];
  const jobs: Job[] = [];
  const open = deps.openKey();

  for (const t of targets) {
    const key = keyOf(t);
    if (!key || key === open) continue;
    const base = (await deps.cache().read(key))?.entry ?? null;
    if (t.ref.kind === "project") {
      const cursor = groupCursor(base);
      if (cursor == null || !t.ref.groupId) {
        fallback.push(t);
        continue;
      }
      jobs.push(job(key, t, base, { group: t.ref.groupId, afterSeq: cursor }, true));
      continue;
    }
    const addr = (t.ref.addr || "").trim();
    if (!addr) continue;
    const cursor = threadCursor(base);
    jobs.push(job(key, t, base, cursor == null ? { addr, newest: true } : { addr, afterSeq: cursor }, false));
  }

  const store = deps.marks ?? marks;
  const mark = scope.id ? store.get(scope.id) ?? null : null;
  /** The first answer's position (read before its reads: the earliest). */
  let since: CatchupSince | null = null;
  /** An answer came from another daemon process: remember nothing. */
  let mixed = false;

  /** Take one answer; `tSent` / `gSent` are the jobs by body position.
   *  Returns whether anything settled. */
  const take = (r: Extract<CatchupResult, { ok: true }>, tSent: Job[], gSent: Job[]): boolean => {
    const at = r.data.since;
    if (!since) since = at;
    else if (!at || at.instanceId !== since.instanceId) mixed = true;
    if (r.data.unchanged) {
      for (const j of tSent) {
        j.done = true;
        j.clean = true;
      }
      return tSent.length > 0;
    }
    let progress = false;
    r.data.threads.forEach((e, i) => {
      const j = tSent[i];
      if (!j) return;
      if (e.kind === "deferred") return;
      progress = true;
      if (e.kind === "error") {
        j.done = true;
        if (goneStatus(e.error.status ?? undefined)) deps.cache().forget(j.key);
        return;
      }
      const moved = !!e.movedFrom || e.resync;
      const ask = j.ask as CatchupThreadAsk;
      if (moved) {
        if (e.resync) deps.cache().forget(j.key);
        j.done = true;
        fallback.push(j.t);
        return;
      }
      if ("newest" in ask) {
        j.page = normThread(e.items);
        j.hasMore = e.hasMore;
        j.conversationId = e.conversationId;
        j.done = true;
        j.clean = true;
        return;
      }
      if (e.conversationId && j.base?.conversationId && e.conversationId !== j.base.conversationId) {
        // The conversation moved: the per-chat read resets the copy.
        j.steps = [];
        j.done = true;
        fallback.push(j.t);
        return;
      }
      const items = normThread(e.items);
      j.steps.push({ removedIds: e.removed.map((x) => x.id), changed: normThread(e.changed), items });
      j.conversationId = e.conversationId ?? j.conversationId;
      const last = items.length ? items[items.length - 1].seq : null;
      if (e.hasMore && typeof last === "number" && last > ask.afterSeq) {
        j.ask = { addr: ask.addr, afterSeq: last };
      } else {
        j.done = true;
        if (e.hasMore) {
          j.steps = [];
          fallback.push(j.t);
        } else j.clean = true;
      }
    });
    r.data.groups.forEach((e, i) => {
      const j = gSent[i];
      if (!j) return;
      if (e.kind === "deferred") return;
      progress = true;
      if (e.kind === "error") {
        j.done = true;
        if (goneStatus(e.error.status ?? undefined)) deps.cache().forget(j.key);
        return;
      }
      const ask = j.ask as CatchupGroupAsk;
      const items = groupMessagesToThread(e.messages, username);
      j.steps.push({
        removedIds: e.removed.map((x) => x.id),
        changed: groupMessagesToThread(e.changed, username),
        items,
      });
      const last = items.length ? items[items.length - 1].readSeq : null;
      if (e.hasMore && typeof last === "number" && last > ask.afterSeq) {
        j.ask = { group: ask.group, afterSeq: last };
      } else {
        j.done = true;
        if (e.hasMore) {
          j.steps = [];
          fallback.push(j.t);
        }
      }
    });
    return progress;
  };

  // The short-cut, for the Threads that were current at the mark and
  // still have a cached copy (one dropped since needs its read). The rest
  // go in the normal rounds after it.
  const quick = mark
    ? jobs.filter((j) => !j.group && j.base && mark.keys.has(j.key) && !hasOpenCard(j.base.messages))
    : [];
  if (mark && quick.length && catchupUnchangedSupported(scope) && deps.usable()) {
    const body = catchupBody(
      quick.map((j) => j.ask as CatchupThreadAsk),
      [],
      CATCHUP_LIMIT,
      mark
    );
    const tSent = body.threads.map((a) => quick.find((j) => (j.ask as CatchupThreadAsk).addr === a.addr)!);
    const r = await post(scope, body);
    if (r.ok) take(r, tSent, []);
  }

  for (let round = 0; round < CATCHUP_MAX_ROUNDS; round++) {
    const live = jobs.filter((j) => !j.done);
    if (!live.length || !deps.usable()) break;
    const tJobs = live.filter((j) => !j.group);
    const gJobs = live.filter((j) => j.group);
    const body = catchupBody(
      tJobs.map((j) => j.ask as CatchupThreadAsk),
      gJobs.map((j) => j.ask as CatchupGroupAsk),
      CATCHUP_LIMIT
    );
    // Over the caps (or duplicates): what did not fit waits for the next
    // round, by position in the body.
    const tSent = body.threads.map((a) => tJobs.find((j) => (j.ask as CatchupThreadAsk).addr === a.addr)!);
    const gSent = body.groups.map((a) => gJobs.find((j) => (j.ask as CatchupGroupAsk).group === a.group)!);
    const r = await post(scope, body);
    if (!r.ok) break;
    if (!take(r, tSent, gSent)) break;
  }

  // Unsettled after the rounds: the per-chat read takes them. Whatever
  // did settle lands in the cache.
  const current = new Set<string>();
  for (const j of jobs) {
    if (!j.done) {
      fallback.push(j.t);
      continue;
    }
    if (!deps.usable() || deps.openKey() === j.key) continue;
    if (!j.group && j.clean) current.add(j.key);
    if (!j.page && !j.steps.length) continue;
    const read: OkRead = {
      ok: true,
      mode: j.page ? "page" : "delta",
      steps: j.steps,
      page: j.page,
      hasMore: j.hasMore,
      conversationId: j.conversationId,
      counts: { items: 0, changed: 0, removed: 0, pages: 1 },
      bytes: null,
    };
    const base = j.base?.messages ?? [];
    const messages = j.group
      ? applyGroupRead(base, read)
      : applyThreadRead(base, read, { conversationId: j.base?.conversationId ?? null });
    deps.cache().remember({
      key: j.key,
      serverId: scope.id,
      messages,
      conversationId: j.conversationId ?? j.base?.conversationId ?? null,
      hasMore: j.hasMore ?? j.base?.hasMore ?? false,
    });
  }
  if (scope.id) {
    const asked = new Set(jobs.filter((j) => !j.group).map((j) => j.key));
    remember(store, scope.id, mark, mixed ? null : since, current, asked);
  }
  return fallback;
}

/** The new mark: this run's current Threads, plus the old mark's that
 *  were not asked again when the position did not move. No position (an older daemon, an App guest, two
 *  daemon processes in one run): no mark. */
function remember(
  store: Map<string, CatchupMark>,
  serverId: string,
  prev: CatchupMark | null,
  at: CatchupSince | null,
  current: Set<string>,
  asked: Set<string>
): void {
  if (!at) {
    // Nothing answered (the call failed): the old mark still holds.
    if (!prev || current.size) store.delete(serverId);
    return;
  }
  const keys = new Set(current);
  if (prev && prev.rev === at.rev && prev.instanceId === at.instanceId) for (const k of prev.keys) if (!asked.has(k)) keys.add(k);
  if (keys.size) store.set(serverId, { rev: at.rev, instanceId: at.instanceId, keys });
  else store.delete(serverId);
}

/** An unanswered choice or secret card, or a permission card still
 *  waiting on an answer (pending, applying, or "already on" before its
 *  Close). Until 0.46.3 ships with K2's rev fixes (728886c5d),
 *  a chat holding one is read in full, never settled by `unchanged` (K2,
 *  2026-10-21). */
export function hasOpenCard(messages: readonly ThreadMessage[]): boolean {
  return messages.some((m) => {
    const c = m.choice;
    if (!c) return false;
    if (c.permission) return c.permission.open;
    return c.answer == null || String(c.answer) === "";
  });
}

/** Same key as `prefetchKey` (not imported: chatPrefetch imports this). */
function keyOf(t: PrefetchTarget): string | null {
  if (!t.serverId) return null;
  if (t.ref.kind === "project") return t.ref.groupId ? threadRoomKey(t.serverId, t.ref.groupId, null) : null;
  const addr = (t.ref.addr || "").trim();
  return addr ? threadRoomKey(t.serverId, null, addr) : null;
}

function job(
  key: string,
  t: PrefetchTarget,
  base: CachedChat | null,
  ask: CatchupThreadAsk | CatchupGroupAsk,
  group: boolean
): Job {
  return {
    key,
    t,
    base,
    ask,
    group,
    steps: [],
    page: null,
    hasMore: null,
    conversationId: base?.conversationId ?? null,
    done: false,
    clean: false,
  };
}
