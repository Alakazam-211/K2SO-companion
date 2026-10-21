import { invoke } from "@tauri-apps/api/core";
import { chatCache, type ChatCache } from "../zen/chatCache";
import { threadRoomKey } from "../zen/outbox";
import { mergeDelta } from "../zen/threadCacheMerge";
import type { ThreadMessage } from "../zen/threadModel";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { normalizeBadgeKey, readBadgeKeys } from "./badgeKeys";

// Messages that came inside sealed pushes (K2 0.46.3 `push-e2e-v1`, the
// sealed Thread alert's `msg`), saved by the Notification Service
// Extension (K2PushInbox.swift) while the app was closed. On launch and on
// every return to the foreground the app drains them into the chat cache,
// so a Thread opened from the notification (or later) already shows them.
// The catch-up that runs next still reconciles everything with the server.
//
// Merged only when it's certain where a message belongs:
//   - one saved account for the push's server (by its label, then badgeKey);
//   - a cached copy of that Thread already exists, for the same conversation;
//   - a plain text message, not cut short (`truncated`), not a card.
// Anything else is dropped here and arrives with the catch-up.

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

/** A sealed message as the Thread draws it (an agent's text: not mine). */
export function inboxMessage(e: InboxEntry): ThreadMessage {
  return {
    id: e.msg.id,
    seq: e.msg.seq,
    text: e.msg.text,
    from: e.msg.from,
    at: e.msg.at,
    mine: false,
    kind: "text",
    choice: null,
  };
}

/** Merge drained entries into the chat cache. Returns how many landed. */
export async function mergeInbox(
  entries: InboxEntry[],
  deps: { cache: () => ChatCache; servers: () => ServerEntry[]; badgeKeys: () => Record<string, string | null | undefined> }
): Promise<number> {
  let landed = 0;
  const servers = deps.servers();
  const keys = deps.badgeKeys();
  for (const e of entries) {
    if (e.msg.kind !== "text" || e.msg.truncated || !e.msg.text || !e.addr) continue;
    const server = inboxServer(e, servers, keys);
    if (!server) continue;
    const key = threadRoomKey(server.id, null, e.addr);
    const hit = (await deps.cache().read(key))?.entry ?? null;
    if (!hit) continue;
    if (hit.conversationId && e.msg.conversationId && hit.conversationId !== e.msg.conversationId) continue;
    if (hit.messages.some((m) => m.id === e.msg.id)) continue;
    deps.cache().remember({
      key,
      serverId: server.id,
      messages: mergeDelta(hit.messages, [inboxMessage(e)]),
      conversationId: hit.conversationId ?? (e.msg.conversationId || null),
      hasMore: hit.hasMore,
    });
    landed += 1;
  }
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

/** On launch and every return to the foreground. Returns the unsubscribe. */
export function installPushInboxDrain(): () => void {
  if (typeof document === "undefined") return () => {};
  const run = () => {
    if (document.visibilityState !== "hidden") void drainPushInbox();
  };
  run();
  document.addEventListener("visibilitychange", run);
  return () => document.removeEventListener("visibilitychange", run);
}
