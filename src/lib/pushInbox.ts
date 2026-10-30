import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { chatCache, type ChatCache } from "../zen/chatCache";
import { threadRoomKey } from "../zen/outbox";
import { mergeDelta } from "../zen/threadCacheMerge";
import type { ThreadMessage } from "../zen/threadModel";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { normalizeBadgeKey, readBadgeKeys } from "./badgeKeys";

// Messages that came inside sealed pushes (K2 0.46.3 `push-e2e-v1`, the
// sealed Thread alert's `msg`), saved by the Notification Service
// Extension (K2PushInbox.swift). The app drains them into the chat cache on
// launch, on every return to the foreground, and on every alert shown
// while it is open (the plugin's `badgeTotals` event), so a Thread opened
// later already shows them. The catch-up still reconciles everything.
//
// Merged only when it's certain where a message belongs:
//   - one saved account for the push's server (by its label, then badgeKey);
//   - a cached copy of that Thread already exists, for the same conversation;
//   - a plain text message, not a card.
// A message cut short to fit the push (`truncated`, anything over about
// 1 KB in format 1) lands too, marked `partial`. Every one is
// `provisional`: never a delta cursor, so the next read fetches it whole,
// and any message before it the push didn't carry (threadCacheMerge
// `newestSeq`). Anything else is dropped here and arrives with the
// catch-up. Diagnostics counts every outcome (`pushInboxStats`).

const PLUGIN = "k2-push";

export type InboxEntry = {
  msg: {
    id: string;
    seq: number | null;
    conversationId: string;
    from: string;
    at: number | null;
    kind: string;
    text: string;
    truncated: boolean;
  };
  subdomain: string;
  badgeKey: string;
  addr: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function parseInboxEntry(raw: unknown): InboxEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const m = o.msg && typeof o.msg === "object" ? (o.msg as Record<string, unknown>) : null;
  if (!m || !str(m.id)) return null;
  return {
    msg: {
      id: str(m.id),
      seq: typeof m.seq === "number" ? m.seq : null,
      conversationId: str(m.conversationId) || str(o.conversationId),
      from: str(m.from),
      at: typeof m.at === "number" ? m.at : null,
      kind: str(m.kind) || "text",
      text: typeof m.text === "string" ? m.text : "",
      truncated: m.truncated === true,
    },
    subdomain: str(o.subdomain).toLowerCase(),
    badgeKey: str(o.badgeKey),
    addr: str(o.addr),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The one saved account this push came from, or null when unsure. */
export function inboxServer(
  e: Pick<InboxEntry, "subdomain" | "badgeKey">,
  servers: ServerEntry[],
  badgeKeys: Record<string, string | null | undefined>
): ServerEntry | null {
  if (!e.subdomain) return null;
  const hits = servers.filter((x) => hostOf(x.url) === `${e.subdomain}.k2.dev`);
  if (hits.length === 1) return hits[0];
  const key = normalizeBadgeKey(e.badgeKey);
  if (!key) return null;
  const byKey = hits.filter((x) => badgeKeys[x.id] === key);
  return byKey.length === 1 ? byKey[0] : null;
}

/** A sealed message as the Thread draws it (an agent's text: not mine),
 *  provisional until a server read confirms it. */
export function inboxMessage(e: InboxEntry): ThreadMessage {
  const m: ThreadMessage = {
    id: e.msg.id,
    seq: e.msg.seq,
    text: e.msg.text,
    from: e.msg.from,
    at: e.msg.at,
    mine: false,
    kind: "text",
    choice: null,
    provisional: true,
  };
  if (e.msg.truncated) m.partial = true;
  return m;
}

/** Why a drained message did not land (Diagnostics). */
export type InboxSkip = "notText" | "noServer" | "notCached" | "otherConversation" | "alreadyThere";

export type PushInboxStats = {
  drains: number;
  received: number;
  landed: number;
  partial: number;
  skipped: Record<InboxSkip, number>;
  lastAt: number | null;
};

function emptyStats(): PushInboxStats {
  return {
    drains: 0,
    received: 0,
    landed: 0,
    partial: 0,
    skipped: { notText: 0, noServer: 0, notCached: 0, otherConversation: 0, alreadyThere: 0 },
    lastAt: null,
  };
}

let stats = emptyStats();
const statsListeners = new Set<() => void>();

/** This run's drain counts (memory only): Server settings → Diagnostics. */
export function pushInboxStats(): PushInboxStats {
  return stats;
}

export function subscribePushInboxStats(fn: () => void): () => void {
  statsListeners.add(fn);
  return () => void statsListeners.delete(fn);
}

function noteStats(update: (s: PushInboxStats) => void): void {
  const next = { ...stats, skipped: { ...stats.skipped } };
  update(next);
  stats = next;
  for (const fn of statsListeners) fn();
}

/** Tests only. */
export function resetPushInboxStats(): void {
  stats = emptyStats();
}

/** Merge drained entries into the chat cache. Returns how many landed. */
export async function mergeInbox(
  entries: InboxEntry[],
  deps: { cache: () => ChatCache; servers: () => ServerEntry[]; badgeKeys: () => Record<string, string | null | undefined> }
): Promise<number> {
  let landed = 0;
  let partial = 0;
  const skipped: Partial<Record<InboxSkip, number>> = {};
  const skip = (why: InboxSkip) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const servers = deps.servers();
  const keys = deps.badgeKeys();
  for (const e of entries) {
    if (e.msg.kind !== "text" || !e.msg.text || !e.addr) {
      skip("notText");
      continue;
    }
    const server = inboxServer(e, servers, keys);
    if (!server) {
      skip("noServer");
      continue;
    }
    const key = threadRoomKey(server.id, null, e.addr);
    const hit = (await deps.cache().read(key))?.entry ?? null;
    if (!hit) {
      skip("notCached");
      continue;
    }
    if (hit.conversationId && e.msg.conversationId && hit.conversationId !== e.msg.conversationId) {
      skip("otherConversation");
      continue;
    }
    if (hit.messages.some((m) => m.id === e.msg.id)) {
      skip("alreadyThere");
      continue;
    }
    deps.cache().remember({
      key,
      serverId: server.id,
      messages: mergeDelta(hit.messages, [inboxMessage(e)]),
      conversationId: hit.conversationId ?? (e.msg.conversationId || null),
      hasMore: hit.hasMore,
    });
    landed += 1;
    if (e.msg.truncated) partial += 1;
  }
  noteStats((s) => {
    s.drains += 1;
    s.received += entries.length;
    s.landed += landed;
    s.partial += partial;
    for (const [k, n] of Object.entries(skipped)) s.skipped[k as InboxSkip] += n ?? 0;
    s.lastAt = Date.now();
  });
  return landed;
}

/** Drain the NSE's inbox (iOS) into the chat cache. Never throws. */
export async function drainPushInbox(): Promise<number> {
  try {
    const r = await invoke<{ available?: boolean; items?: unknown[] }>(`plugin:${PLUGIN}|e2e_op`, { op: "drainInbox" });
    const entries = (r?.items ?? []).map(parseInboxEntry).filter((x): x is InboxEntry => !!x);
    if (!entries.length) return 0;
    return await mergeInbox(entries, {
      cache: chatCache,
      servers: () => useServersStore.getState().servers.filter((x) => useServersStore.getState().tokens[x.id]),
      badgeKeys: () => readBadgeKeys(),
    });
  } catch {
    return 0;
  }
}

/** On launch, every return to the foreground, and every alert shown while
 *  the app is open (the NSE has stored its message by then; the plugin's
 *  `badgeTotals` event follows it). Returns the unsubscribe. */
export function installPushInboxDrain(): () => void {
  if (typeof document === "undefined") return () => {};
  const run = () => {
    if (document.visibilityState !== "hidden") void drainPushInbox();
  };
  run();
  document.addEventListener("visibilitychange", run);
  let unlisten: (() => void) | null = null;
  let gone = false;
  void addPluginListener(PLUGIN, "badgeTotals", run)
    .then((l) => {
      if (gone) void l.unregister();
      else unlisten = () => void l.unregister();
    })
    .catch(() => undefined);
  return () => {
    gone = true;
    document.removeEventListener("visibilitychange", run);
    unlisten?.();
  };
}
