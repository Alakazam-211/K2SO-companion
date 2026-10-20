// Image thumbnails for Thread attachments (K2 0.46.3 `thread-images-v1`),
// kept on the device so a reopened chat draws its pictures at once.
//
// Key (K2): (server, path, live modifiedAt, live size). A message's
// attachment in state `ok` carries the live values; `changed` means they
// moved, so the caller asks `mode=meta` first and the key changes with the
// file. `gone` / `hidden` drop it. Thumbs live in memory (an LRU) and in
// IndexedDB (`k2-thumb-cache`), under the chat cache's privacy rules
// (chatCacheWiring): a server signed out, removed or re-keyed forgets its
// thumbs; no servers left clears them all.

export type CachedThumb = {
  key: string;
  serverId: string;
  /** `image/jpeg` | `image/png` | `image/svg+xml`. */
  mime: string;
  width: number;
  height: number;
  base64: string;
  /** ms since epoch: LRU order. */
  savedAt: number;
  bytes: number;
};

type ThumbMeta = Pick<CachedThumb, "key" | "serverId" | "savedAt" | "bytes">;

/** Memory LRU size (entries). */
export const THUMB_MEMORY_MAX = 120;
/** Device budget: entries and bytes (base64 length). */
export const THUMB_DEVICE_MAX = 400;
export const THUMB_DEVICE_MAX_BYTES = 24 * 1024 * 1024;

export function thumbKey(
  serverId: string,
  path: string,
  modifiedAt: number | null,
  size: number | null,
  px: number
): string {
  return `${serverId}|${px}|${modifiedAt ?? ""}|${size ?? ""}|${path}`;
}

/** The data URL a thumb draws as (an `<img>` only: SVG is never inlined). */
export function thumbSrc(t: Pick<CachedThumb, "mime" | "base64">): string {
  return `data:${t.mime};base64,${t.base64}`;
}

interface ThumbBackend {
  loadIndex(): Promise<ThumbMeta[]>;
  get(key: string): Promise<CachedThumb | null>;
  put(t: CachedThumb): Promise<void>;
  delete(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "k2-thumb-cache";
const DB_VERSION = 1;
const THUMBS = "thumbs";
const META = "meta";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function indexedDbThumbs(factory: IDBFactory | undefined = globalThis.indexedDB): ThumbBackend | null {
  if (!factory) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const name of Array.from(d.objectStoreNames)) d.deleteObjectStore(name);
        d.createObjectStore(THUMBS, { keyPath: "key" });
        d.createObjectStore(META, { keyPath: "key" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
      r.onblocked = () => reject(new Error("IndexedDB open blocked"));
    }));
  return {
    async loadIndex() {
      const tx = (await db()).transaction(META, "readonly");
      return (await req(tx.objectStore(META).getAll())) as ThumbMeta[];
    },
    async get(key) {
      const tx = (await db()).transaction(THUMBS, "readonly");
      return ((await req(tx.objectStore(THUMBS).get(key))) as CachedThumb | undefined) ?? null;
    },
    async put(t) {
      const tx = (await db()).transaction([THUMBS, META], "readwrite");
      tx.objectStore(THUMBS).put(t);
      tx.objectStore(META).put({ key: t.key, serverId: t.serverId, savedAt: t.savedAt, bytes: t.bytes });
      await done(tx);
    },
    async delete(keys) {
      if (!keys.length) return;
      const tx = (await db()).transaction([THUMBS, META], "readwrite");
      for (const k of keys) {
        tx.objectStore(THUMBS).delete(k);
        tx.objectStore(META).delete(k);
      }
      await done(tx);
    },
    async clear() {
      const tx = (await db()).transaction([THUMBS, META], "readwrite");
      tx.objectStore(THUMBS).clear();
      tx.objectStore(META).clear();
      await done(tx);
    },
  };
}

export interface ThumbCache {
  /** Memory only (synchronous): what a tile can draw on its first frame. */
  peek(key: string): CachedThumb | null;
  /** Memory, then the device. */
  get(key: string): Promise<CachedThumb | null>;
  put(t: Omit<CachedThumb, "savedAt" | "bytes">): void;
  /** Drop one key (the file went away or is hidden). */
  drop(key: string): void;
  forgetServer(serverId: string): Promise<void>;
  /** Keep only these servers' thumbs (start-up prune). */
  prune(serverIds: readonly string[]): Promise<void>;
  clearAll(): Promise<void>;
}

export function createThumbCache(backend: ThumbBackend | null, now: () => number = Date.now): ThumbCache {
  const mem = new Map<string, CachedThumb>();
  let index: Map<string, ThumbMeta> | null = null;
  let broken = !backend;
  /** Anything forgotten while a device read was in flight must stay gone. */
  let generation = 0;

  const remember = (t: CachedThumb) => {
    mem.delete(t.key);
    mem.set(t.key, t);
    while (mem.size > THUMB_MEMORY_MAX) {
      const oldest = mem.keys().next().value;
      if (oldest === undefined) break;
      mem.delete(oldest);
    }
  };

  const run = async <T>(op: (b: ThumbBackend) => Promise<T>, fallback: T): Promise<T> => {
    if (broken || !backend) return fallback;
    try {
      return await op(backend);
    } catch (e) {
      broken = true;
      console.warn("[thumb-cache] IndexedDB failed; memory only from here", e);
      return fallback;
    }
  };

  const loadIndex = async (): Promise<Map<string, ThumbMeta>> => {
    if (index) return index;
    const rows = await run((b) => b.loadIndex(), [] as ThumbMeta[]);
    index ??= new Map(rows.map((r) => [r.key, r]));
    return index;
  };

  const evict = async () => {
    const idx = await loadIndex();
    let bytes = 0;
    for (const m of idx.values()) bytes += m.bytes;
    if (idx.size <= THUMB_DEVICE_MAX && bytes <= THUMB_DEVICE_MAX_BYTES) return;
    const order = [...idx.values()].sort((a, b) => a.savedAt - b.savedAt);
    const out: string[] = [];
    let count = idx.size;
    for (const m of order) {
      if (count <= THUMB_DEVICE_MAX && bytes <= THUMB_DEVICE_MAX_BYTES) break;
      out.push(m.key);
      idx.delete(m.key);
      count -= 1;
      bytes -= m.bytes;
    }
    await run((b) => b.delete(out), undefined);
  };

  const dropWhere = async (match: (serverId: string) => boolean) => {
    generation += 1;
    for (const [k, t] of [...mem]) if (match(t.serverId)) mem.delete(k);
    const idx = await loadIndex();
    const keys = [...idx.values()].filter((m) => match(m.serverId)).map((m) => m.key);
    for (const k of keys) idx.delete(k);
    await run((b) => b.delete(keys), undefined);
  };

  return {
    peek: (key) => {
      const t = mem.get(key);
      if (t) remember(t);
      return t ?? null;
    },
    async get(key) {
      const hit = mem.get(key);
      if (hit) {
        remember(hit);
        return hit;
      }
      const gen = generation;
      const row = await run((b) => b.get(key), null);
      if (!row || gen !== generation) return null;
      remember(row);
      return row;
    },
    put(t) {
      const full: CachedThumb = { ...t, savedAt: now(), bytes: t.base64.length };
      remember(full);
      void (async () => {
        const idx = await loadIndex();
        idx.set(full.key, { key: full.key, serverId: full.serverId, savedAt: full.savedAt, bytes: full.bytes });
        await run((b) => b.put(full), undefined);
        await evict();
      })();
    },
    drop(key) {
      mem.delete(key);
      index?.delete(key);
      void run((b) => b.delete([key]), undefined);
    },
    forgetServer: (serverId) => dropWhere((id) => id === serverId),
    prune: (serverIds) => {
      const keep = new Set(serverIds);
      return dropWhere((id) => !keep.has(id));
    },
    async clearAll() {
      generation += 1;
      mem.clear();
      index = new Map();
      await run((b) => b.clear(), undefined);
    },
  };
}

let shared: ThumbCache | null = null;

/** The app's thumb cache (IndexedDB when this WebView has it). */
export function thumbCache(): ThumbCache {
  shared ??= createThumbCache(indexedDbThumbs());
  return shared;
}

/** Tests: a fresh memory-only cache. */
export function __resetThumbCacheForTests(): void {
  shared = createThumbCache(null);
}
