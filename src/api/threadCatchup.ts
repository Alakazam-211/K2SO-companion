// `POST /cli/thread/catchup` (K2 0.46.3 `inbox-catchup-v1`): many chats'
// "what's new" in one call. Each served Thread entry is exactly the plain
// `GET /cli/thread` body for that chat (a delta for `afterSeq`, the newest
// page for `newest`), minus `ok`; each group entry is the project chat
// messages body. Entries come back in request order (after de-duplication)
// and are matched by position. A failing chat is an error on its entry
// only; the 4 MiB byte budget cuts one entry (`has_more`) and defers the
// rest (`deferred`, top-level `has_more`). One call in flight per token: a
// second is 429 `{retryAfterMs}`.
//
// `catchup-unchanged-v1` (K2 0.46.3): send back the last answer's `rev` +
// `instanceId` (`sinceRev`, both or neither) and, when no Thread was
// written since in that daemon process, the answer is just
// `{ok, rev, instanceId, unchanged: true}` with no reads. Threads only:
// project chat posts don't move `rev`.

import type { ProjectGroupMessage } from "./projectGroups";
import { permissionCardsOn, type ServerScope } from "./scope";
import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import type { ThreadItem } from "./client";

export const FEATURE_INBOX_CATCHUP = "inbox-catchup-v1" as const;
export const FEATURE_CATCHUP_UNCHANGED = "catchup-unchanged-v1" as const;
export const CATCHUP_MAX_THREADS = 200;
export const CATCHUP_MAX_GROUPS = 50;
export const CATCHUP_LIMIT = 50;
/** 429 retries before giving up on this round. */
const MAX_RATE_RETRIES = 2;
const CATCHUP_TIMEOUT_MS = 30_000;

export function catchupSupported(scope: ServerScope): boolean {
  return !!scope.id && scope.supports(FEATURE_INBOX_CATCHUP);
}

export function catchupUnchangedSupported(scope: ServerScope): boolean {
  return catchupSupported(scope) && scope.supports(FEATURE_CATCHUP_UNCHANGED);
}

/** A catch-up answer's position: `rev` (read before its first store read)
 *  in that daemon process (`instanceId`). */
export type CatchupSince = { rev: number; instanceId: string };

export type CatchupThreadAsk = { addr: string; afterSeq: number } | { addr: string; newest: true };
export type CatchupGroupAsk = { group: string; afterSeq: number };

export type CatchupError = { status: number | null; code: string; hint: string };

export type CatchupThreadEntry =
  | {
      kind: "served";
      /** The address the chat answers at now (after a rename, `movedFrom`
       *  holds what was sent). */
      addr: string;
      movedFrom: string | null;
      conversationId: string | null;
      /** Present on an `afterSeq` (delta) answer. */
      afterSeq: number | null;
      items: ThreadItem[];
      changed: ThreadItem[];
      removed: { id: string }[];
      /** Delta: newer remain. Newest page: older exist. */
      hasMore: boolean;
      /** Reserved (C3): drop the copy, read the newest page. */
      resync: boolean;
    }
  | { kind: "error"; addr: string; error: CatchupError }
  | { kind: "deferred"; addr: string };

export type CatchupGroupEntry =
  | {
      kind: "served";
      group: string;
      groupId: string | null;
      messages: ProjectGroupMessage[];
      changed: ProjectGroupMessage[];
      removed: { id: string }[];
      hasMore: boolean;
    }
  | { kind: "error"; group: string; error: CatchupError }
  | { kind: "deferred"; group: string };

export type CatchupAnswer = {
  /** Null on an older daemon (and for App guests). */
  since: CatchupSince | null;
  /** `sinceRev` still current: no entries, nothing changed in any Thread. */
  unchanged: boolean;
  hasMore: boolean;
  threads: CatchupThreadEntry[];
  groups: CatchupGroupEntry[];
};

export type CatchupResult = { ok: true; data: CatchupAnswer } | { ok: false; error: CatchupError };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function removedOf(v: unknown): { id: string }[] {
  return arr<unknown>(v)
    .map((r) => (r && typeof r === "object" ? str((r as Record<string, unknown>).id) : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
}

function errorOf(o: Record<string, unknown>): CatchupError {
  const e = o.error;
  const status = typeof o.status === "number" ? o.status : null;
  if (e && typeof e === "object") {
    const x = e as Record<string, unknown>;
    return { status, code: str(x.code), hint: str(x.hint) || str(x.code) };
  }
  return { status, code: str(e), hint: str(e) };
}

/** One `threads[]` entry; `sent` is what was asked at that position. */
export function parseThreadEntry(raw: unknown, sent: CatchupThreadAsk): CatchupThreadEntry {
  // Missing (a shorter answer than asked): ask again next round.
  if (raw == null || typeof raw !== "object") return { kind: "deferred", addr: sent.addr };
  const o = raw as Record<string, unknown>;
  const addr = str(o.addr) || sent.addr;
  if (o.deferred === true) return { kind: "deferred", addr: sent.addr };
  if (o.error != null || (typeof o.status === "number" && o.status >= 400)) {
    return { kind: "error", addr: sent.addr, error: errorOf(o) };
  }
  return {
    kind: "served",
    addr,
    movedFrom: str(o.movedFrom) || null,
    conversationId: str(o.conversation_id) || null,
    afterSeq: typeof o.after_seq === "number" ? o.after_seq : null,
    items: arr<ThreadItem>(o.items),
    changed: arr<ThreadItem>(o.changed),
    removed: removedOf(o.removed),
    hasMore: o.has_more === true,
    resync: o.resync === true,
  };
}

export function parseGroupEntry(raw: unknown, sent: CatchupGroupAsk): CatchupGroupEntry {
  if (raw == null || typeof raw !== "object") return { kind: "deferred", group: sent.group };
  const o = raw as Record<string, unknown>;
  if (o.deferred === true) return { kind: "deferred", group: sent.group };
  if (o.error != null || (typeof o.status === "number" && o.status >= 400)) {
    return { kind: "error", group: sent.group, error: errorOf(o) };
  }
  return {
    kind: "served",
    group: sent.group,
    groupId: str(o.groupId) || null,
    messages: arr<ProjectGroupMessage>(o.messages),
    changed: arr<ProjectGroupMessage>(o.changed),
    removed: removedOf(o.removed),
    hasMore: o.has_more === true || o.truncated === true,
  };
}

/** The asks as the route takes them: one per address (the first wins),
 *  at most the caps. `since`: ask for the `unchanged` short-cut. */
export function catchupBody(
  threads: readonly CatchupThreadAsk[],
  groups: readonly CatchupGroupAsk[],
  limit = CATCHUP_LIMIT,
  since: CatchupSince | null = null
): { threads: CatchupThreadAsk[]; groups: CatchupGroupAsk[]; limit: number; since?: CatchupSince } {
  const seenT = new Set<string>();
  const t: CatchupThreadAsk[] = [];
  for (const a of threads) {
    if (!a.addr || seenT.has(a.addr) || t.length >= CATCHUP_MAX_THREADS) continue;
    if ("afterSeq" in a && !(Number.isInteger(a.afterSeq) && a.afterSeq >= 0)) continue;
    seenT.add(a.addr);
    t.push("afterSeq" in a ? { addr: a.addr, afterSeq: a.afterSeq } : { addr: a.addr, newest: true });
  }
  const seenG = new Set<string>();
  const g: CatchupGroupAsk[] = [];
  for (const a of groups) {
    if (!a.group || seenG.has(a.group) || g.length >= CATCHUP_MAX_GROUPS) continue;
    if (!(Number.isInteger(a.afterSeq) && a.afterSeq >= 0)) continue;
    seenG.add(a.group);
    g.push({ group: a.group, afterSeq: a.afterSeq });
  }
  const ok = since && Number.isInteger(since.rev) && since.rev >= 0 && since.instanceId.trim();
  return ok ? { threads: t, groups: g, limit, since: { rev: since.rev, instanceId: since.instanceId.trim() } } : { threads: t, groups: g, limit };
}

export type CatchupDeps = {
  fetch?: typeof scopedFetch;
  sleep?: (ms: number) => Promise<void>;
};

/** One catch-up call (the body from `catchupBody`). A 429 waits its
 *  `retryAfterMs` and tries again (twice at most). Never throws. */
export async function postCatchup(
  scope: ServerScope,
  body: ReturnType<typeof catchupBody>,
  deps: CatchupDeps = {}
): Promise<CatchupResult> {
  const doFetch = deps.fetch ?? scopedFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const payload = JSON.stringify({
    threads: body.threads,
    limit: body.limit,
    ...(body.groups.length ? { groups: body.groups } : null),
    // K2 0.46.3 permission cards: the rich card doc in every entry.
    ...(permissionCardsOn(scope) ? { cards: 2 } : null),
    ...(body.since ? { sinceRev: body.since.rev, instanceId: body.since.instanceId } : null),
  });
  for (let attempt = 0; ; attempt++) {
    let out;
    try {
      out = await doFetch(scope, "/cli/thread/catchup", { method: "POST", body: payload, timeoutMs: CATCHUP_TIMEOUT_MS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { status: null, code: msg === NOT_CONNECTED ? "not_connected" : "network", hint: msg } };
    }
    if (out.status === 429 && attempt < MAX_RATE_RETRIES) {
      let wait = 1000;
      try {
        const j = JSON.parse(out.text) as { retryAfterMs?: unknown };
        if (typeof j.retryAfterMs === "number" && j.retryAfterMs > 0) wait = Math.min(j.retryAfterMs, 10_000);
      } catch {
        /* default wait */
      }
      await sleep(wait);
      continue;
    }
    if (!out.ok) {
      let code = "";
      try {
        code = errorOf(JSON.parse(out.text) as Record<string, unknown>).code;
      } catch {
        /* plain text */
      }
      return { ok: false, error: { status: out.status, code: code || `http_${out.status}`, hint: out.text.slice(0, 200) } };
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(out.text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: { status: out.status, code: "bad_response", hint: "not JSON" } };
    }
    const rev = typeof j.rev === "number" && Number.isInteger(j.rev) && j.rev >= 0 ? j.rev : null;
    const instanceId = str(j.instanceId);
    const since = rev != null && instanceId ? { rev, instanceId } : null;
    if (j.unchanged === true && body.since && since) {
      return { ok: true, data: { since, unchanged: true, hasMore: false, threads: [], groups: [] } };
    }
    const rawT = arr<unknown>(j.threads);
    const rawG = arr<unknown>(j.groups);
    return {
      ok: true,
      data: {
        since,
        unchanged: false,
        hasMore: j.has_more === true,
        threads: body.threads.map((sent, i) => parseThreadEntry(rawT[i], sent)),
        groups: body.groups.map((sent, i) => parseGroupEntry(rawG[i], sent)),
      },
    };
  }
}
