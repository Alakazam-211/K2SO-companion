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
  type StashItem,
  type StashQuote,
  type StashSource,
} from "./stashModel";
import { indexedDbStashBackend, memoryStashBackend, type StashBackend, type StashBlob } from "./stashBackend";

// The person's prompt stash on this device (stashModel has the spec).
// Every write goes to storage before the caller is told "saved", so a
// composer clears only after its draft is safe. "Remove after use" is a
// device setting (localStorage, like the other Zen prefs), off by default:
// a used stash stays, a template.

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

export type StashTaken = { text: string; files: File[]; quotes: StashQuote[] };

type StashState = {
  items: StashItem[];
  hydrated: boolean;
  removeAfterUse: boolean;
  hydrate: () => Promise<void>;
  save: (input: StashSaveInput, opts?: { replaceOldest?: boolean }) => Promise<StashSaveResult>;
  remove: (id: string) => Promise<void>;
  /** The stash's content to put in a composer (removing it when the
   *  setting says so), or null when it is gone. */
  take: (id: string) => Promise<StashTaken | null>;
  setRemoveAfterUse: (on: boolean) => void;
};

let backend: StashBackend | null = null;
function store(): StashBackend {
  return (backend ??= indexedDbStashBackend() ?? memoryStashBackend());
}

/** Tests: a fresh backend and an empty, unhydrated store. */
export function __resetStashForTests(b: StashBackend = memoryStashBackend()): void {
  backend = b;
  hydrating = null;
  useStashStore.setState({ items: [], hydrated: false, removeAfterUse: readRemoveAfterUse() });
}

let hydrating: Promise<void> | null = null;

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
  removeAfterUse: readRemoveAfterUse(),

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= (async () => {
      let items: StashItem[] = [];
      try {
        items = await store().loadAll();
        const expired = expiredTombstones(items);
        if (expired.length) {
          await store().remove(expired, []);
          items = items.filter((i) => !expired.includes(i.id));
        }
      } catch (e) {
        // A broken database: this run keeps its stashes in memory.
        console.warn("[stash] load failed:", e);
        backend = memoryStashBackend();
      }
      // Saves made before the load finished stay.
      const mine = new Set(get().items.map((i) => i.id));
      set({ items: [...get().items, ...items.filter((i) => !mine.has(i.id))], hydrated: true });
    })();
    return hydrating;
  },

  save: async (input, opts) => {
    const files = input.files ?? [];
    if (!hasStashContent(input.text, files.length)) return "empty";
    await get().hydrate();
    const replacing = stashIsFull(get().items) ? oldestLive(get().items) : null;
    if (replacing && !opts?.replaceOldest) return "full";
    try {
      const blobs = await filesToBlobs(files);
      const item = makeStashItem({
        text: input.text,
        quotes: input.quotes,
        source: input.source,
        attachments: blobs.map((b, i) => ({ id: b.id, name: b.name, type: b.type, size: files[i].size })),
      });
      await store().put(item, blobs);
      let items = [...get().items, item];
      if (replacing) {
        const dead = tombstone(replacing);
        await store().put(dead);
        await store().remove([], replacing.attachments.map((a) => a.id));
        items = items.map((i) => (i.id === dead.id ? dead : i));
      }
      set({ items });
      return "saved";
    } catch (e) {
      console.warn("[stash] save failed:", e);
      return "error";
    }
  },

  remove: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || item.deleted_at != null) return;
    const dead = tombstone(item);
    set({ items: get().items.map((i) => (i.id === id ? dead : i)) });
    try {
      await store().put(dead);
      await store().remove([], item.attachments.map((a) => a.id));
    } catch (e) {
      console.warn("[stash] delete failed:", e);
    }
  },

  take: async (id) => {
    const item = liveStash(get().items).find((i) => i.id === id);
    if (!item) return null;
    let files: File[] = [];
    if (item.attachments.length) {
      try {
        const blobs = await store().getBlobs(item.attachments.map((a) => a.id));
        const byId = new Map(blobs.map((b) => [b.id, b]));
        files = item.attachments.flatMap((a) => {
          const b = byId.get(a.id);
          return b ? [new File([b.buf], a.name, { type: a.type })] : [];
        });
      } catch (e) {
        console.warn("[stash] attachments unreadable:", e);
      }
    }
    const taken = { text: item.text, files, quotes: item.quotes };
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
