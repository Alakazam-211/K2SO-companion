// The Home ROWS' side of Home chat (the chat view's own state is in
// `./homeChatStore`). What Home knows of each server's Home chat (K2 0.46.13, brief §2.2,
// §2.4–2.7): its gate, its people, its channels, its summary (badges), and
// the DMs this phone opened. One entry per saved server, read with THAT
// server's own login (`scopeFor`); never the active server's.
//
//   - The gate is the API layer's (`refreshHomeChatGate`); this store keeps
//     a copy for rendering and hears every change (`onHomeChatGate`).
//   - People, channels and the summary are read only once the gate is
//     open. A failed read keeps the last answer (rows keep their last
//     badge, greyed by the error).
//   - Live: `useHomeChatLive` holds each offered server's events socket
//     while Home shows its rows, and re-reads the summary on
//     `summary_changed` / `member_removed` / `read` and after a reconnect.
//   - Gone: the chat view's `onHomeChatGone` — a channel you LEFT comes off
//     every group (a synced Home edit); one DELETED (archived, history
//     read-only) stays, greyed, until you remove it.
//
// The preview harness and tests seed it directly (`seedHomeChatServer`).

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { scopeFor } from "../../api/scope";
import {
  fetchHomeChatChannels,
  fetchHomeChatPeople,
  fetchHomeChatSummary,
  homeChatGateNow,
  onHomeChatGate,
  openHomeChatDm,
  refreshHomeChatGate,
  type HomeChatGate,
} from "../../api/homeChat";
import { subscribeHomeChat } from "../../api/homeChatEvents";
import type { HomeChatChannel, HomeChatPeople, HomeChatSummary } from "../../api/homeChatPure";
import { onServerForget, useServersStore } from "../../stores/servers";
import { openHomeChat, type OpenHomeChatTarget } from "./openHomeChat";
import { onHomeChatGone, type HomeChatGone } from "./homeChatStore";
import { chatRowParts } from "./homeChatRows";
import { useHomesStore } from "../homes";
import { entryMatchesHomeHost } from "../homeServerIds";

export interface HomeChatServerState {
  /** Null until read. */
  gate: HomeChatGate | null;
  people: HomeChatPeople | null;
  peopleAt: number | null;
  peopleError: string | null;
  channels: HomeChatChannel[] | null;
  channelsAt: number | null;
  channelsError: string | null;
  summary: HomeChatSummary | null;
  summaryError: string | null;
  /** ext → the DM's conversation id, as `/cli/home-chat/dm` answered. */
  dms: Record<string, string>;
}

export const EMPTY_CHAT_SERVER: HomeChatServerState = Object.freeze({
  gate: null,
  people: null,
  peopleAt: null,
  peopleError: null,
  channels: null,
  channelsAt: null,
  channelsError: null,
  summary: null,
  summaryError: null,
  dms: {},
}) as HomeChatServerState;

/** People and channel lists stay good this long (a forced read skips it). */
export const HOME_CHAT_LIST_FRESH_MS = 60_000;

interface HomeChatRowsStore {
  byServer: Record<string, HomeChatServerState>;
  /** A row's note after a failed open (address → words), cleared later. */
  rowNotes: Record<string, string>;
  /** `<serverId>|<conv>` of channels deleted (archived) from this phone. */
  deleted: Record<string, true>;
}

export const useHomeChatRowsStore = create<HomeChatRowsStore>(() => ({ byServer: {}, rowNotes: {}, deleted: {} }));

/** The words a deleted channel's row shows. */
export const CHANNEL_DELETED_LINE = "Deleted · read-only";

function patch(serverId: string, p: Partial<HomeChatServerState>): void {
  useHomeChatRowsStore.setState((s) => ({
    byServer: { ...s.byServer, [serverId]: { ...(s.byServer[serverId] ?? EMPTY_CHAT_SERVER), ...p } },
  }));
}

export function chatServer(serverId: string): HomeChatServerState {
  return useHomeChatRowsStore.getState().byServer[serverId] ?? EMPTY_CHAT_SERVER;
}

/** Seed one server (preview harness, tests). */
export function seedHomeChatServer(serverId: string, p: Partial<HomeChatServerState>): void {
  patch(serverId, p);
}

// The gate's own changes (a closing refusal, the socket's flags).
let gateHooked = false;
function hookGate(): void {
  if (gateHooked) return;
  gateHooked = true;
  onHomeChatGate((id, gate) => patch(id, { gate }));
  onServerForget((id) =>
    useHomeChatRowsStore.setState((s) => {
      if (!(id in s.byServer)) return s;
      const byServer = { ...s.byServer };
      delete byServer[id];
      return { byServer };
    })
  );
}

const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Read `serverId`'s gate (fresh for 2 min unless `force`). Never throws. */
export async function refreshChatGate(serverId: string, force = false): Promise<HomeChatGate | null> {
  if (!serverId) return null;
  hookGate();
  try {
    const scope = scopeFor(serverId);
    const gate = await refreshHomeChatGate(scope, { force });
    patch(serverId, { gate });
    return gate;
  } catch {
    return null;
  }
}

/** The gate as this store knows it (no I/O). */
export function chatGateOffered(serverId: string): boolean {
  return !!chatServer(serverId).gate?.offered;
}

/** Read `serverId`'s people (when its gate is open). */
export function refreshChatPeople(serverId: string, force = false): Promise<void> {
  return once(`people|${serverId}`, async () => {
    const st = chatServer(serverId);
    if (!st.gate?.offered) return;
    if (!force && st.peopleAt !== null && Date.now() - st.peopleAt < HOME_CHAT_LIST_FRESH_MS) return;
    const r = await fetchHomeChatPeople(scopeFor(serverId));
    if (r.ok) patch(serverId, { people: { me: r.me, people: r.people }, peopleAt: Date.now(), peopleError: null });
    else patch(serverId, { peopleError: r.hint || r.code });
  });
}

/** Read `serverId`'s channels (the first page of Sew browse). */
export function refreshChatChannels(serverId: string, force = false): Promise<void> {
  return once(`channels|${serverId}`, async () => {
    const st = chatServer(serverId);
    if (!st.gate?.offered) return;
    if (!force && st.channelsAt !== null && Date.now() - st.channelsAt < HOME_CHAT_LIST_FRESH_MS) return;
    const r = await fetchHomeChatChannels(scopeFor(serverId));
    if (r.ok) patch(serverId, { channels: r.channels, channelsAt: Date.now(), channelsError: null });
    else patch(serverId, { channelsError: r.hint || r.code });
  });
}

/** Read `serverId`'s summary (every conversation's badge). */
export function refreshChatSummary(serverId: string): Promise<void> {
  return once(`summary|${serverId}`, async () => {
    if (!chatServer(serverId).gate?.offered) return;
    const r = await fetchHomeChatSummary(scopeFor(serverId));
    if (r.ok) patch(serverId, { summary: { chat: r.chat, convs: r.convs }, summaryError: null });
    else patch(serverId, { summaryError: r.hint || r.code });
  });
}

/** Gate, then (when open) summary and people: what Home's rows need. */
export async function refreshChatServer(serverId: string, opts: { people?: boolean; channels?: boolean } = {}): Promise<void> {
  const gate = await refreshChatGate(serverId);
  if (!gate?.offered) return;
  await Promise.all([
    refreshChatSummary(serverId),
    opts.people === false ? Promise.resolve() : refreshChatPeople(serverId),
    opts.channels ? refreshChatChannels(serverId) : Promise.resolve(),
  ]);
}

export function noteChatDm(serverId: string, ext: string, conv: string): void {
  const st = chatServer(serverId);
  if (st.dms[ext] === conv) return;
  patch(serverId, { dms: { ...st.dms, [ext]: conv } });
}

const NOTE_MS = 4_000;
function noteRow(address: string, words: string): void {
  useHomeChatRowsStore.setState((s) => ({ rowNotes: { ...s.rowNotes, [address]: words } }));
  setTimeout(() => {
    useHomeChatRowsStore.setState((s) => {
      if (s.rowNotes[address] !== words) return s;
      const rowNotes = { ...s.rowNotes };
      delete rowNotes[address];
      return { rowNotes };
    });
  }, NOTE_MS);
}

/** Open a person or channel row: a person's DM is opened (or made) first
 *  with `/cli/home-chat/dm`; then the chat view (`openHomeChat`). A gate
 *  not read yet is read first; a closed one opens nothing. False (and a
 *  note on the row) when it couldn't. */
export async function openHomeChatRow(
  serverId: string,
  row: { kind: "person" | "channel"; handle: string; title: string; address: string; inviteOnly?: boolean | null }
): Promise<boolean> {
  let gate = chatServer(serverId).gate;
  if (!gate || gate.checkedAt === null) gate = await refreshChatGate(serverId);
  if (!gate?.offered) {
    noteRow(row.address, gate?.pickerLine ?? "No chat on this server.");
    return false;
  }
  let conv = row.kind === "channel" ? row.handle : chatServer(serverId).dms[row.handle] ?? null;
  if (!conv) {
    const r = await openHomeChatDm(scopeFor(serverId), row.handle);
    if (!r.ok) {
      noteRow(row.address, r.kind === "network" || r.kind === "not_connected" ? "Couldn’t reach the server. Try again." : r.hint || "Couldn’t open the chat.");
      return false;
    }
    conv = r.conv;
    noteChatDm(serverId, row.handle, conv);
  }
  const target: OpenHomeChatTarget = {
    serverId,
    kind: row.kind,
    conversationId: conv,
    title: row.title,
    address: row.address,
    ...(row.kind === "person" ? { ext: row.handle } : { inviteOnly: row.inviteOnly ?? null }),
  };
  openHomeChat(target);
  return true;
}

// ─── Live ───

const SUMMARY_DEBOUNCE_MS = 300;

/** Read `gateIds`' gates (and, where open, summaries and people), and hold
 *  the events sockets of `liveIds` (offered servers only: the servers
 *  whose rows are on screen) to keep their summaries current. A gate that
 *  opens later subscribes then. */
export function useHomeChatLive(
  gateIds: readonly string[],
  liveIds: readonly string[] = gateIds,
  opts: { people?: boolean } = {}
): void {
  const key = [...new Set(gateIds.filter(Boolean))].sort().join("\n");
  const liveKey = [...new Set(liveIds.filter(Boolean))].sort().join("\n");
  const offeredKey = useHomeChatRowsStore((s) =>
    liveKey
      .split("\n")
      .filter((id) => id && s.byServer[id]?.gate?.offered)
      .join("\n")
  );
  const wantPeople = opts.people !== false;
  // Read every gate (and, when open, summary and people).
  useEffect(() => {
    for (const id of key ? key.split("\n") : []) void refreshChatServer(id, { people: wantPeople });
  }, [key, wantPeople]);
  // One socket per offered server.
  useEffect(() => {
    const ids = offeredKey ? offeredKey.split("\n") : [];
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const soon = (id: string) => {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void refreshChatSummary(id);
        }, SUMMARY_DEBOUNCE_MS)
      );
    };
    const unsubs = ids.map((id) => {
      try {
        return subscribeHomeChat(
          scopeFor(id),
          (f) => {
            if (f.type === "summary_changed" || f.type === "member_removed" || f.type === "read" || f.type === "message") soon(id);
            else if (f.type === "status" || f.type === "hello") patch(id, { gate: homeChatGateNow(scopeFor(id)) });
          },
          {
            onLink: (info) => {
              if (info.up && info.reopened) soon(id);
            },
          }
        );
      } catch {
        return () => {};
      }
    });
    return () => {
      for (const u of unsubs) u();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [offeredKey]);
}

/** A channel left or deleted in the chat view (`onHomeChatGone`). Left:
 *  its row comes off every group (you're not in it any more). Deleted:
 *  the row stays, greyed (`CHANNEL_DELETED_LINE`). */
export function noteChannelGone(g: HomeChatGone): void {
  if (g.why === "deleted") {
    useHomeChatRowsStore.setState((s) => ({ deleted: { ...s.deleted, [`${g.serverId}|${g.conv}`]: true } }));
    void refreshChatChannels(g.serverId, true);
    return;
  }
  const entry = useServersStore.getState().servers.find((x) => x.id === g.serverId);
  if (!entry) return;
  const st = useHomesStore.getState();
  for (const h of st.homes) {
    for (const r of h.rows) {
      const parts = chatRowParts(r);
      if (parts?.kind === "channel" && parts.handle === g.conv && entryMatchesHomeHost(entry, parts.host)) {
        useHomesStore.getState().removeRow(h.id, r.address);
      }
    }
  }
  void refreshChatSummary(g.serverId);
}

/** Hear the chat view's left / deleted channels while Home is up. */
export function useHomeChatGoneRows(on: boolean): void {
  useEffect(() => (on ? onHomeChatGone(noteChannelGone) : undefined), [on]);
}

/** Some server in `serverIds` offers people and channels (the gate is
 *  open): Add to Home shows its People and Channels tabs. */
export function useAnyChatOffered(serverIds: readonly string[]): boolean {
  const key = useMemo(() => serverIds.join("\n"), [serverIds]);
  return useHomeChatRowsStore((s) => (key ? key.split("\n") : []).some((id) => !!s.byServer[id]?.gate?.offered));
}

/** Tests only. */
export function __resetHomeChatRowsStoreForTests(): void {
  useHomeChatRowsStore.setState({ byServer: {}, rowNotes: {}, deleted: {} });
  inflight.clear();
}
