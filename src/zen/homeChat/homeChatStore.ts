// The open Home chat (a DM or a channel, K2 0.46.13 `home-chat-v1`) and
// what this phone holds of each conversation it opened: messages (merged
// by id, oldest first; optimistic sends until the server's copy with the
// same nonce lands), sends in flight or failed, who is typing, and each
// server's people (names and member ids).
//
// `openHomeChat` is the entry point other parts call (Home rows, a push
// tap later): the HomeChatHost in Zen shows the view while `open` is set.
// Memory only: a relaunch reads the server again.

import type { ComponentType } from "react";
import { create } from "zustand";
import type { HomeChatMembers, HomeChatMessage, HomeChatPeople } from "../../api/homeChatPure";
import {
  mergeHomeChatMessages,
  typingCleared,
  typingNoted,
  typingPruned,
  type PendingSend,
  type TypingRoster,
} from "../../api/homeChatHelpers";
import type { HomeChatTarget } from "./homeChatModel";

export interface ConvState {
  /** Oldest first; `~<nonce>` ids are sends not yet confirmed. */
  messages: HomeChatMessage[];
  /** Sew has older messages than the first one held. */
  hasMore: boolean;
  /** A page has been read since the view opened (else: cached / none). */
  loaded: boolean;
  /** The last read failed (the words to show), null when fine. */
  error: string | null;
  loadingOlder: boolean;
}

export const EMPTY_CONV: ConvState = Object.freeze({
  messages: [],
  hasMore: true,
  loaded: false,
  error: null,
  loadingOlder: false,
}) as ConvState;

export interface SendState {
  pending: PendingSend;
  status: "sending" | "failed";
  error: string | null;
}

interface HomeChatStore {
  open: HomeChatTarget | null;
  /** convKey → its messages and read state. */
  convs: Record<string, ConvState>;
  /** convKey → nonce → a send not yet confirmed. */
  sends: Record<string, Record<string, SendState>>;
  /** convKey → who is typing (member → when their name clears). */
  typing: Record<string, TypingRoster>;
  /** serverId → its people answer (names, your member id). */
  people: Record<string, { people: HomeChatPeople; at: number }>;
  /** `<serverId>|<ext>` → that DM's conversation, once known. */
  dms: Record<string, string>;
  /** convKey → a channel's facts (name, open, creator, people). */
  channels: Record<string, HomeChatMembers>;
  openChat: (target: HomeChatTarget) => void;
  closeChat: () => void;
  patchConv: (key: string, patch: Partial<ConvState>) => void;
  mergeMessages: (key: string, incoming: readonly HomeChatMessage[]) => void;
  mapMessages: (key: string, fn: (list: HomeChatMessage[]) => HomeChatMessage[]) => void;
  setSend: (key: string, nonce: string, s: SendState | null) => void;
  setPeople: (serverId: string, people: HomeChatPeople, at?: number) => void;
  noteDm: (serverId: string, ext: string, conv: string) => void;
  setChannel: (key: string, members: HomeChatMembers) => void;
  noteTyping: (key: string, member: string, now: number) => void;
  clearTyping: (key: string, member: string) => void;
  pruneTyping: (now: number) => void;
}

export const useHomeChatStore = create<HomeChatStore>((set) => ({
  open: null,
  convs: {},
  sends: {},
  typing: {},
  people: {},
  dms: {},
  channels: {},
  openChat: (target) => set({ open: { ...target } }),
  closeChat: () => set((s) => (s.open ? { open: null } : s)),
  patchConv: (key, patch) =>
    set((s) => ({ convs: { ...s.convs, [key]: { ...(s.convs[key] ?? EMPTY_CONV), ...patch } } })),
  mergeMessages: (key, incoming) =>
    set((s) => {
      if (incoming.length === 0) return s;
      const cur = s.convs[key] ?? EMPTY_CONV;
      const messages = mergeHomeChatMessages(cur.messages, incoming);
      return messages === cur.messages ? s : { convs: { ...s.convs, [key]: { ...cur, messages } } };
    }),
  mapMessages: (key, fn) =>
    set((s) => {
      const cur = s.convs[key];
      if (!cur) return s;
      const messages = fn(cur.messages);
      return messages === cur.messages ? s : { convs: { ...s.convs, [key]: { ...cur, messages } } };
    }),
  setSend: (key, nonce, st) =>
    set((s) => {
      const cur = { ...(s.sends[key] ?? {}) };
      if (st) cur[nonce] = st;
      else if (nonce in cur) delete cur[nonce];
      else return s;
      return { sends: { ...s.sends, [key]: cur } };
    }),
  setPeople: (serverId, people, at = Date.now()) => set((s) => ({ people: { ...s.people, [serverId]: { people, at } } })),
  noteDm: (serverId, ext, conv) =>
    set((s) => {
      const k = `${serverId}|${ext}`;
      return s.dms[k] === conv ? s : { dms: { ...s.dms, [k]: conv } };
    }),
  setChannel: (key, members) => set((s) => ({ channels: { ...s.channels, [key]: members } })),
  noteTyping: (key, member, now) =>
    set((s) => ({ typing: { ...s.typing, [key]: typingNoted(s.typing[key] ?? {}, member, now) } })),
  clearTyping: (key, member) =>
    set((s) => {
      const cur = s.typing[key];
      if (!cur) return s;
      const next = typingCleared(cur, member);
      return next === cur ? s : { typing: { ...s.typing, [key]: next } };
    }),
  pruneTyping: (now) =>
    set((s) => {
      let changed = false;
      const typing: Record<string, TypingRoster> = {};
      for (const [k, roster] of Object.entries(s.typing)) {
        const next = typingPruned(roster, now);
        if (next !== roster) changed = true;
        if (Object.keys(next).length > 0) typing[k] = next;
        else if (Object.keys(roster).length > 0) changed = true;
      }
      return changed ? { typing } : s;
    }),
}));

/** Open a DM or a channel on its server (the view slides over Zen; swipe
 *  back or Back closes it). For a DM known only by person, pass `ext` and
 *  `conversationId: null`. Gate first (`homeChatOffered`): this never
 *  checks it. */
export function openHomeChat(target: HomeChatTarget): void {
  useHomeChatStore.getState().openChat(target);
}

/** Close the open Home chat (if any). */
export function closeHomeChat(): void {
  useHomeChatStore.getState().closeChat();
}

/** A channel the person left or deleted here: other parts (Home rows)
 *  hear it to drop or grey the row. */
export type HomeChatGone = { serverId: string; conv: string; why: "left" | "deleted" };
const goneListeners = new Set<(g: HomeChatGone) => void>();

export function onHomeChatGone(fn: (g: HomeChatGone) => void): () => void {
  goneListeners.add(fn);
  return () => {
    goneListeners.delete(fn);
  };
}

export function noteHomeChatGone(g: HomeChatGone): void {
  for (const fn of [...goneListeners]) {
    try {
      fn(g);
    } catch {
      /* a listener never breaks the sheet */
    }
  }
}

// ─── Hooks for DM calls (another part wires calls) ───

/** The open conversation, as the call hooks get it. */
export interface HomeChatConversation {
  serverId: string;
  kind: "dm" | "channel";
  conversationId: string;
  title: string;
  /** A DM's other person, when known. */
  ext: string | null;
}

export interface HomeChatCallHooks {
  /** A call record line's "Call back" (absent: no button). */
  onCallBack?: (conversation: HomeChatConversation) => void;
  /** Buttons at the right of a DM's header (the Call button), given the
   *  conversation once it is known (null while the DM opens). */
  HeaderActions?: ComponentType<{ conversation: HomeChatConversation | null; target: HomeChatTarget }>;
}

export const useHomeChatCallHooks = create<HomeChatCallHooks>(() => ({}));

/** The calls part registers its Call button and Call back here; the host
 *  passes them to the view (props given to `HomeChatView` directly win). */
export function setHomeChatCallHooks(hooks: HomeChatCallHooks): void {
  useHomeChatCallHooks.setState(hooks, true);
}

/** Tests and the preview: forget everything. */
export function resetHomeChatStore(): void {
  useHomeChatStore.setState({ open: null, convs: {}, sends: {}, typing: {}, people: {}, dms: {}, channels: {} });
  goneListeners.clear();
}
