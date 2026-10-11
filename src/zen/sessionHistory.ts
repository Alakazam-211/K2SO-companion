import type { ActiveLlm } from "./llmPresets";
import { normalizeHarness } from "./llmHarness";
import { sidecarSuffix } from "./sidecarRows";

/** Sessions drawer History: past conversations in one workspace that are
 *  not open now. Sources (K2 daemon, all Member GETs):
 *  - `/cli/chat/list?project_path=`: every harness conversation on disk
 *    (desktop Chat History). Its id is the Thread's conversation key.
 *  - `/cli/thread/latest?addrs=`: a bare conversation id is a Thread addr
 *    (`MsgTarget::Session`) when K2 hosted it; `not_found` when K2 never did.
 *  - The phone's remembered sidecars (`ws/handle`), which keep the sidecar
 *    address so a reopen respawns the host the usual way. */

export const HISTORY_PAGE = 50;

const CONVERSATION_ADDR =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bare conversation id used as a Thread addr (a History row), not a
 *  workspace handle. Workspace handles are slugs, never UUIDs. */
export function isConversationAddr(addr: string | null | undefined): boolean {
  return CONVERSATION_ADDR.test((addr || "").trim());
}
/** `/cli/thread/latest` takes at most this many addrs per request. */
export const THREAD_LATEST_MAX = 50;

/** One live PTY from `/cli/sessions/list-for-workspace`. */
export type LiveWorkspaceSession = {
  sessionId: string;
  kind: string;
  handle: string;
  conversationId: string | null;
  command: string | null;
};

export type ChatListEntry = {
  id: string;
  provider: string | null;
  title: string;
  /** Unix seconds. */
  at: number | null;
  archived: boolean;
};

export type LatestEntry = {
  addr: string;
  conversationId: string | null;
  /** Unix seconds of the last Thread message; null = empty Thread. */
  at: number | null;
  /** K2 has no Thread at this addr. */
  missing: boolean;
};

export type HistoryRow = {
  /** Thread addr: `ws/handle` for a remembered sidecar, else the conversation id. */
  addr: string;
  /** Line one. */
  title: string;
  /** Line two, when it says more than line one. */
  label: string | null;
  harness: string | null;
  /** Unix seconds, last used. */
  at: number | null;
  conversationId: string | null;
};

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>)[key])) {
    return (data as Record<string, unknown[]>)[key];
  }
  return [];
}

function seconds(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

export function parseWorkspaceLive(data: unknown): LiveWorkspaceSession[] {
  const out: LiveWorkspaceSession[] = [];
  for (const raw of list(data, "sessions")) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const sessionId = text(r.sessionId);
    if (!sessionId) continue;
    out.push({
      sessionId,
      kind: text(r.kind),
      handle: text(r.handle),
      conversationId: text(r.conversationId) || null,
      command: text(r.command) || null,
    });
  }
  return out;
}

/** Thread addr for a live plain tab: its `ws/N` handle (sidecar-shaped,
 *  survives renames), else its conversation id. Null = blank shell. */
export function threadAddrOfLive(live: LiveWorkspaceSession | undefined): string | null {
  if (!live) return null;
  if (live.kind !== "canonical" && live.handle.includes("/")) return live.handle;
  return live.conversationId;
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\s+/g, " ").trim();
}

export function parseChatList(data: unknown): ChatListEntry[] {
  const out: ChatListEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list(data, "sessions")) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = text(r.sessionId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      provider: normalizeHarness(text(r.provider)) ?? null,
      title: firstLine(typeof r.title === "string" ? r.title : ""),
      at: seconds(r.timestamp),
      archived: r.archived === true,
    });
  }
  return out;
}

export function parseCustomNames(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const name = text(v);
    if (name) out[k] = name;
  }
  return out;
}

export function parseThreadLatest(data: unknown): Map<string, LatestEntry> {
  const out = new Map<string, LatestEntry>();
  for (const raw of list(data, "items")) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const addr = text(r.addr);
    if (!addr) continue;
    out.set(addr, {
      addr,
      conversationId: text(r.conversationId) || null,
      at: seconds(r.at),
      missing: !!r.error,
    });
  }
  return out;
}

/** Chats worth a Thread lookup, newest first: not archived, not open now. */
export function historyCandidates(
  chats: ChatListEntry[],
  activeConversations: Set<string>
): ChatListEntry[] {
  return chats
    .filter((c) => !c.archived && !activeConversations.has(c.id))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

function newer(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** History rows, newest first. A conversation K2 never hosted has no
 *  Thread (`thread/latest` → not_found) and is left out: a row must open
 *  a Thread. A chat not yet looked up (past the page) is left out too. */
export function buildHistory(input: {
  chats: ChatListEntry[];
  names?: Record<string, string>;
  remembered: { addr: string; chatTitle?: string | null }[];
  latest: Map<string, LatestEntry>;
  activeAddrs: Set<string>;
  activeConversations: Set<string>;
}): HistoryRow[] {
  const names = input.names ?? {};
  const rows: HistoryRow[] = [];
  const byConversation = new Map<string, HistoryRow>();
  const seenAddr = new Set<string>();
  for (const r of input.remembered) {
    const addr = (r.addr || "").trim();
    if (!addr || seenAddr.has(addr) || input.activeAddrs.has(addr)) continue;
    const lat = input.latest.get(addr);
    if (!lat || lat.missing) continue;
    const conv = lat.conversationId;
    if (conv && (input.activeConversations.has(conv) || byConversation.has(conv))) continue;
    seenAddr.add(addr);
    const suffix = sidecarSuffix(addr);
    const title = (r.chatTitle || "").trim();
    const row: HistoryRow = {
      addr,
      title: addr,
      label: title && title !== suffix ? title : null,
      harness: null,
      at: lat.at,
      conversationId: conv,
    };
    rows.push(row);
    if (conv) byConversation.set(conv, row);
  }
  for (const c of input.chats) {
    if (c.archived || input.activeConversations.has(c.id)) continue;
    const named = c.provider ? names[`${c.provider}:${c.id}`] : undefined;
    const hit = byConversation.get(c.id);
    if (hit) {
      hit.harness = c.provider;
      hit.at = newer(hit.at, c.at);
      if (!hit.label && named) hit.label = named;
      continue;
    }
    const lat = input.latest.get(c.id);
    if (!lat || lat.missing || seenAddr.has(c.id)) continue;
    seenAddr.add(c.id);
    const row: HistoryRow = {
      addr: c.id,
      title: named || c.title || "Untitled chat",
      label: null,
      harness: c.provider,
      at: newer(c.at, lat.at),
      conversationId: c.id,
    };
    rows.push(row);
    byConversation.set(c.id, row);
  }
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (b.row.at ?? -Infinity) - (a.row.at ?? -Infinity) || a.i - b.i)
    .map((x) => x.row);
}

/** Split addrs into `/cli/thread/latest` sized batches. */
export function latestBatches(addrs: string[]): string[][] {
  const uniq = [...new Set(addrs.map((a) => a.trim()).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < uniq.length; i += THREAD_LATEST_MAX) out.push(uniq.slice(i, i + THREAD_LATEST_MAX));
  return out;
}

/** Program for a harness when no enabled preset runs it. */
const HARNESS_BIN: Record<string, string> = { cursor: "cursor-agent" };

/** Launch line to respawn a past session with its own LLM. Prefers the
 *  server's enabled preset for that harness. Null = the spawn default
 *  (Claude), which is right for Claude and for an unknown harness. */
export function launchForHarness(
  harness: string | null | undefined,
  llms: ActiveLlm[] | null | undefined
): { command: string; args: string[] } | null {
  const h = (harness || "").trim();
  if (!h) return null;
  const preset = (llms ?? []).find((l) => l.harness === h);
  if (preset) return { command: preset.command, args: preset.args };
  if (h === "claude") return null;
  return { command: HARNESS_BIN[h] ?? h, args: [] };
}
