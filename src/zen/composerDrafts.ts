import { create } from "zustand";
import { threadRoomKey } from "./outbox";

// Composer drafts: what you typed in a Thread chat and did not send, so
// leaving the chat (or relaunching the app) and coming back puts it back.
// Phone-only, never sent to a server. Text only: picked files are not kept.
//
// Keyed per room like the outbox (`threadRoomKey`): `<serverId>|t:<addr>`
// for a main chat or a sidecar (`handle/2` is its own addr), and
// `<serverId>|g:<groupId>` for a project chat. The same handle on two
// servers is two drafts. A room with no server or no addr/group yet
// (still opening) keeps nothing.
//
// Stored in `k2.zen.drafts.v1` as `{key: {text, at}}`; the newest
// DRAFTS_MAX are kept and an empty draft is dropped. Typing updates memory
// at once and storage after DRAFT_SAVE_MS of quiet; `flush()` writes now
// (the Thread calls it on unmount and when the app goes to the
// background). Every storage access is in try/catch: a failure keeps the
// draft in memory for this run.

export const DRAFTS_KEY = "k2.zen.drafts.v1";
/** Rooms remembered; the oldest drafts drop off past this. */
export const DRAFTS_MAX = 100;
/** Quiet time (ms) before typing is written to storage. */
export const DRAFT_SAVE_MS = 250;

export type ComposerDraft = { text: string; at: number };

/** The room's draft key, or null while it has no server or address. */
export function composerDraftKey(
  serverId: string | null | undefined,
  groupId: string | null | undefined,
  addr: string | null | undefined
): string | null {
  if (!serverId) return null;
  if (!(groupId || "").trim() && !(addr || "").trim()) return null;
  return threadRoomKey(serverId, groupId, addr);
}

/** `{key: {text, at}}`; anything else reads as empty. */
export function readDrafts(): Record<string, ComposerDraft> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, ComposerDraft> = {};
    for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
      if (!d || typeof d !== "object") continue;
      const { text, at } = d as { text?: unknown; at?: unknown };
      if (typeof text !== "string" || !text.trim()) continue;
      out[k] = { text, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/** Keep the newest `max` drafts. */
export function trimDrafts(
  drafts: Record<string, ComposerDraft>,
  max = DRAFTS_MAX
): Record<string, ComposerDraft> {
  const keys = Object.keys(drafts);
  if (keys.length <= max) return drafts;
  return Object.fromEntries(
    keys
      .sort((a, b) => drafts[b].at - drafts[a].at)
      .slice(0, max)
      .map((k) => [k, drafts[k]])
  );
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function writeDrafts(drafts: Record<string, ComposerDraft>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode: kept in memory */
  }
}

type ComposerDraftsState = {
  drafts: Record<string, ComposerDraft>;
  /** The room's text now; empty (or blank) drops it. No key: nothing kept. */
  setDraft: (key: string | null, text: string, at?: number) => void;
  /** Write any pending change to storage now. */
  flush: () => void;
  /** Re-read storage (tests; an app relaunch). */
  reload: () => void;
};

export const useComposerDrafts = create<ComposerDraftsState>((set, get) => ({
  drafts: readDrafts(),
  setDraft: (key, text, at = Date.now()) => {
    if (!key) return;
    const drafts = get().drafts;
    let next: Record<string, ComposerDraft>;
    if (!text.trim()) {
      if (!(key in drafts)) return;
      next = { ...drafts };
      delete next[key];
    } else {
      if (drafts[key]?.text === text) return;
      next = trimDrafts({ ...drafts, [key]: { text, at } });
    }
    set({ drafts: next });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().flush(), DRAFT_SAVE_MS);
  },
  flush: () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeDrafts(get().drafts);
  },
  reload: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    set({ drafts: readDrafts() });
  },
}));

/** The room's saved text, or "". */
export function composerDraftOf(key: string | null): string {
  return key ? useComposerDrafts.getState().drafts[key]?.text ?? "" : "";
}
