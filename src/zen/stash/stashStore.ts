import { useMemo } from "react";
import { create } from "zustand";
import {
  expiredTombstones,
  hasStashContent,
  liveStash,
  makeStashItem,
  newStashId,
  oldestLive,
  stashIsFull,
  tombstone,
  type StashAttachment,
  type StashItem,
  type StashQuote,
  type StashSource,
} from "./stashModel";
import { indexedDbStashBackend, type StashBackend, type StashBlob } from "./stashBackend";
import { homesDeviceId, loadHomesDevices, useHomesSyncStore } from "../homesSync";

// The person's prompt stash on this device (stashModel has the spec).
// Every write goes to storage before the caller is told "saved", so a
// composer clears only after its draft is safe. Storage that can't be
// opened is never papered over: saves fail ("error", the draft stays),
// the sheet says the stash is unavailable, and the next open tries again.
// Writes run one at a time (two saves at 49 can't make 51). "Remove after
// use" is a device setting (localStorage, like the other Zen prefs), off
// by default: a used stash stays, a template.

export const STASH_REMOVE_AFTER_USE_KEY = "k2.zen.stash.removeAfterUse";

export function readRemoveAfterUse(): boolean {
  try {
    return localStorage.getItem(STASH_REMOVE_AFTER_USE_KEY) === "1";
  } catch {
    return false;
  }
}

export type StashSaveInput = {
  text: string;
  files?: readonly File[];
  quotes?: StashQuote[];
  source?: Partial<StashSource>;
};

/** `full`: the cap is reached; ask, then save with `replaceOldest`. */
export type StashSaveResult = "saved" | "full" | "empty" | "error";

/** A stash's content for a composer; `missing` files are not here:
 *  saved on another device (`elsewhere`, synced), or their bytes could
 *  not be read. */
export type StashTaken = { text: string; files: File[]; quotes: StashQuote[]; missing: StashMissingFile[] };
export type StashMissingFile = StashAttachment & { elsewhere: boolean };

/** Device id → name from the Homes-sync device list (the one source of
 *  device names; they can be renamed), read once when not loaded yet.
 *  Empty when Home sync is off or the list can't be read. */
export async function stashDeviceNames(): Promise<Map<string, string>> {
  const serverId = useHomesSyncStore.getState().serverId;
  if (!serverId) return new Map();
  if (!useHomesSyncStore.getState().devices[serverId]) {
    try {
      await loadHomesDevices(serverId);
    } catch {
      /* "another device" */
    }
  }
  const list = useHomesSyncStore.getState().devices[serverId] ?? [];
  return new Map(list.map((d) => [d.deviceId, d.name]));
}

/** This phone's device id (the Homes-sync one), or null if unknown. */
async function thisDevice(): Promise<string | null> {
  try {
    return await homesDeviceId();
  } catch {
    return null;
  }
}

type StashState = {
  items: StashItem[];
  hydrated: boolean;
  /** Storage could not be opened or read (the last try). */
  unavailable: boolean;
  removeAfterUse: boolean;
  hydrate: () => Promise<void>;
  save: (input: StashSaveInput, opts?: { replaceOldest?: boolean }) => Promise<StashSaveResult>;
  remove: (id: string) => Promise<void>;
  /** The stash's content to put in a composer (removing it when the
   *  setting says so), or null when it is gone. */
  take: (id: string) => Promise<StashTaken | null>;
  setRemoveAfterUse: (on: boolean) => void;
};

let backend: StashBackend | null | undefined;
function store(): StashBackend | null {
  if (backend === undefined) backend = indexedDbStashBackend();
  return backend;
}

let hydrating: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** One write at a time, in call order. */
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run);
  queue = next.catch(() => undefined);
  return next;
}

/** Tests: a backend (null: no IndexedDB) and an empty, unhydrated store. */
export function __resetStashForTests(b: StashBackend | null): void {
  backend = b;
  hydrating = null;
  queue = Promise.resolve();
  useStashStore.setState({ items: [], hydrated: false, unavailable: false, removeAfterUse: readRemoveAfterUse() });
}

async function filesToBlobs(files: readonly File[]): Promise<StashBlob[]> {
  const out: StashBlob[] = [];
  for (const f of files) {
    out.push({ id: newStashId(), name: f.name || "file", type: f.type, buf: await f.arrayBuffer() });
  }
  return out;
}

export const useStashStore = create<StashState>((set, get) => ({
  items: [],
  hydrated: false,
  unavailable: false,
  removeAfterUse: readRemoveAfterUse(),

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= (async () => {
      const b = store();
      if (!b) {
        set({ unavailable: true });
        hydrating = null;
        return;
      }
      try {
        let items = await b.loadAll();
        const expired = expiredTombstones(items);
        if (expired.length) {
          await b.write({ deleteItems: expired });
          items = items.filter((i) => !expired.includes(i.id));
        }
        set({ items, hydrated: true, unavailable: false });
      } catch (e) {
        // Not this time: saves fail and the next hydrate tries again.
        console.warn("[stash] load failed:", e);
        set({ unavailable: true });
        hydrating = null;
      }
    })();
    return hydrating;
  },

  save: async (input, opts) => {
    const files = input.files ?? [];
    if (!hasStashContent(input.text, files.length)) return "empty";
    await get().hydrate();
    const b = store();
    if (!get().hydrated || !b) return "error";
    const device = files.length ? await thisDevice() : null;
    return serial(async () => {
      const replacing = stashIsFull(get().items) ? oldestLive(get().items) : null;
      if (replacing && !opts?.replaceOldest) return "full" as const;
      try {
        const blobs = await filesToBlobs(files);
        const item = makeStashItem({
          text: input.text,
          quotes: input.quotes,
          source: input.source,
          attachments: blobs.map((x, i) => ({
            id: x.id,
            name: x.name,
            type: x.type,
            size: files[i].size,
            device_id: device,
            path: null,
          })),
        });
        const dead = replacing ? tombstone(replacing) : null;
        await b.write({
          put: dead ? [item, dead] : [item],
          putBlobs: blobs,
          deleteBlobs: replacing ? replacing.attachments.map((a) => a.id) : [],
        });
        set({ items: [...get().items.map((i) => (dead && i.id === dead.id ? dead : i)), item] });
        return "saved" as const;
      } catch (e) {
        console.warn("[stash] save failed:", e);
        return "error" as const;
      }
    });
  },

  remove: (id) =>
    serial(async () => {
      const item = liveStash(get().items).find((i) => i.id === id);
      const b = store();
      if (!item || !b) return;
      const dead = tombstone(item);
      try {
        await b.write({ put: [dead], deleteBlobs: item.attachments.map((a) => a.id) });
        set({ items: get().items.map((i) => (i.id === id ? dead : i)) });
      } catch (e) {
        console.warn("[stash] delete failed:", e);
      }
    }),

  take: async (id) => {
    const item = liveStash(get().items).find((i) => i.id === id);
    if (!item) return null;
    // Only this phone's files have bytes here (no device id: saved
    // before sync, so here too).
    const device = item.attachments.length ? await thisDevice() : null;
    const local = item.attachments.filter((a) => a.device_id == null || a.device_id === device);
    const byId = new Map<string, StashBlob>();
    if (local.length) {
      try {
        for (const x of (await store()?.getBlobs(local.map((a) => a.id))) ?? []) byId.set(x.id, x);
      } catch (e) {
        console.warn("[stash] attachments unreadable:", e);
      }
    }
    const files: File[] = [];
    const missing: StashMissingFile[] = [];
    for (const a of item.attachments) {
      const x = byId.get(a.id);
      if (x) files.push(new File([x.buf], a.name, { type: a.type }));
      else missing.push({ ...a, elsewhere: !local.includes(a) });
    }
    const taken = { text: item.text, files, quotes: item.quotes, missing };
    if (get().removeAfterUse) await get().remove(id);
    return taken;
  },

  setRemoveAfterUse: (on) => {
    try {
      localStorage.setItem(STASH_REMOVE_AFTER_USE_KEY, on ? "1" : "0");
    } catch {
      /* the choice lasts this session */
    }
    set({ removeAfterUse: on });
  },
}));

/** Live stashes, newest first (the list and the button's count). */
export function useLiveStash(): StashItem[] {
  const items = useStashStore((s) => s.items);
  return useMemo(() => liveStash(items), [items]);
}
