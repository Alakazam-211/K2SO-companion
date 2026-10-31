import { invoke, isTauri } from "@tauri-apps/api/core";
import { useServersStore } from "../stores/servers";
import type { ServerUnread, UnreadEntry, UnreadTotals } from "../zen/unread";
import { subdomainOfServerUrl } from "./avatarCache";
import { badgeKeyOf } from "./badgeKeys";
import { PUSH_PLUGIN, pushAvailability } from "./pushAvailability";

// Read elsewhere → gone from Notification Center (iOS; the plan is
// `.k2/wiki/Plan - Clear Notifications on Read Elsewhere`). The unread
// store (`zen/unreadStore`) calls this with what it learns:
//   - a `thread_read` / `project_read` frame or read reply that leaves a
//     chat with nothing unread or waiting: that chat's notifications up to
//     its read cursor go (`read`);
//   - totals at 0, or the summary read on open / foreground: every Thread
//     and project notification from that server goes, except chats still
//     unread above their cursor, or with a card waiting (`keepOnly`).
// Native (`K2DeliveredClear.swift`) matches by server (badgeKey, else
// tunnel label) and chat, and never touches a notification newer than the
// state (`before`) unless its seq says it's read. The silent badge push
// does the same in the background (totals 0, and K2 0.46.8 read hints).
// Best-effort and quiet: a no-op off iOS or without push; never throws.

export type ClearChat = { kind: "thread" | "project"; id: string; seq?: number };
export type ClearPlan = { mode: "read" | "keepOnly"; chats: ClearChat[] };

/** What one chat's new state clears, or null. */
export function planForEntry(entry: UnreadEntry, totals: UnreadTotals | null): ClearPlan | null {
  if (totals && totals.total === 0) return { mode: "keepOnly", chats: [] };
  if (entry.unread > 0 || entry.waiting > 0) return null;
  const chat: ClearChat = { kind: entry.kind, id: entry.id };
  if (entry.lastReadSeq > 0) chat.seq = entry.lastReadSeq;
  return { mode: "read", chats: [chat] };
}

/** What a server's whole state (the summary) clears: everything but the
 *  chats still unread (above their cursor) or with a card waiting. */
export function planForSummary(s: ServerUnread): ClearPlan {
  const chats: ClearChat[] = [];
  for (const e of Object.values(s.byKey)) {
    if (e.unread <= 0 && e.waiting <= 0) continue;
    const chat: ClearChat = { kind: e.kind, id: e.id };
    // A waiting card keeps every notification of its chat.
    if (e.waiting <= 0 && e.lastReadSeq > 0) chat.seq = e.lastReadSeq;
    chats.push(chat);
  }
  return { mode: "keepOnly", chats };
}

type Deps = {
  supported: () => Promise<boolean>;
  call: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  serverUrl: (serverId: string) => string | null;
  badgeKeyOf: (serverId: string) => string | null;
};

/** Tauri, push available, iOS (the badge totals' gate). */
async function iosPush(): Promise<boolean> {
  try {
    if (!isTauri()) return false;
    const a = await pushAvailability();
    return a.available && a.platform === "ios";
  } catch {
    return false;
  }
}

const defaultDeps: Deps = {
  supported: iosPush,
  call: (cmd, args) => invoke(`plugin:${PUSH_PLUGIN}|${cmd}`, args),
  serverUrl: (serverId) => useServersStore.getState().servers.find((s) => s.id === serverId)?.url ?? null,
  badgeKeyOf: (serverId) => badgeKeyOf(serverId),
};

let deps: Deps = defaultDeps;

/** Ask native to clear what `plan` covers on `serverId`, as of `before`
 *  (ms; the time the state was read). Never throws. */
export async function clearDelivered(serverId: string, plan: ClearPlan | null, before = Date.now()): Promise<void> {
  try {
    if (!plan) return;
    const subdomain = subdomainOfServerUrl(deps.serverUrl(serverId));
    // Off `*.k2.dev` no push ever names this server.
    if (!subdomain) return;
    if (!(await deps.supported())) return;
    const badgeKey = deps.badgeKeyOf(serverId);
    await deps.call("clear_delivered", {
      ...(badgeKey ? { badgeKey } : {}),
      subdomain,
      mode: plan.mode,
      chats: plan.chats,
      before,
    });
  } catch (e) {
    console.warn("[notifications] clear skipped:", e);
  }
}

export function __setDeliveredClearDepsForTests(next: Partial<Deps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}
