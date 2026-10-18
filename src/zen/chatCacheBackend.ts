import type { ThreadMessage } from "./threadModel";

// The chat cache's on-device store: a tiny IndexedDB wrapper (no deps),
// and an in-memory stand-in for when IndexedDB is missing or throws
// (private mode, tests, a corrupt database). Nothing goes to localStorage.

/** Bump to drop every cached chat (an incompatible entry shape). */
export const CHAT_CACHE_SCHEMA = 1;

export type CachedChat = {
  /** Entry shape version (`CHAT_CACHE_SCHEMA`). */
  v: number;
  /** Room key: `<serverId>|t:<addr>` or `<serverId>|g:<groupId>`. */
  key: string;
  serverId: string;
  /** Oldest first, at most `CACHE_MAX_MESSAGES`. */
  messages: ThreadMessage[];
  conversationId: string | null;
  /** The server had (or the cache cut) older messages. */
  hasMore: boolean;
  /** ms since epoch: LRU order. */
  savedAt: number;
  /** Approximate size (JSON length): the byte budget. */
  bytes: number;
};

/** What eviction needs, without the messages. */
export type CachedChatMeta = Pick<CachedChat, "key" | "serverId" | "savedAt" | "bytes">;

export interface ChatCacheBackend {
  readonly kind: "indexeddb" | "memory";
  loadIndex(): Promise<CachedChatMeta[]>;
  get(key: string): Promise<CachedChat | null>;
  put(entry: CachedChat): Promise<void>;
  delete(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export function metaOf(e: CachedChat): CachedChatMeta {
  return { key: e.key, serverId: e.serverId, savedAt: e.savedAt, bytes: e.bytes };
}

/** In memory only (the fallback, and tests). */
export function memoryBackend(): ChatCacheBackend {
  const rows = new Map<string, CachedChat>();
  return {
    kind: "memory",
    loadIndex: async () => [...rows.values()].map(metaOf),
    get: async (key) => rows.get(key) ?? null,
    put: async (entry) => {
      rows.set(entry.key, entry);
    },
    delete: async (keys) => {
      for (const k of keys) rows.delete(k);
    },
    clear: async () => {
      rows.clear();
    },
  };
}

const DB_NAME = "k2-chat-cache";
const CHATS = "chats";
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

/** Open the database. The schema version IS the database version: an
 *  upgrade from any other version drops every store (cache, not data). */
function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(DB_NAME, CHAT_CACHE_SCHEMA);
    } catch (e) {
      reject(e);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(CHATS, { keyPath: "key" });
      db.createObjectStore(META, { keyPath: "key" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    r.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** IndexedDB, or null when this WebView has none. */
export function indexedDbBackend(factory: IDBFactory | undefined = globalThis.indexedDB): ChatCacheBackend | null {
  if (!factory) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb(factory));
  return {
    kind: "indexeddb",
    async loadIndex() {
      const d = await db();
      const tx = d.transaction(META, "readonly");
      return (await req(tx.objectStore(META).getAll())) as CachedChatMeta[];
    },
    async get(key) {
      const d = await db();
      const tx = d.transaction(CHATS, "readonly");
      const row = (await req(tx.objectStore(CHATS).get(key))) as CachedChat | undefined;
      return row ?? null;
    },
    async put(entry) {
      const d = await db();
      const tx = d.transaction([CHATS, META], "readwrite");
      tx.objectStore(CHATS).put(entry);
      tx.objectStore(META).put(metaOf(entry));
      await done(tx);
    },
    async delete(keys) {
      if (!keys.length) return;
      const d = await db();
      const tx = d.transaction([CHATS, META], "readwrite");
      for (const k of keys) {
        tx.objectStore(CHATS).delete(k);
        tx.objectStore(META).delete(k);
      }
      await done(tx);
    },
    async clear() {
      const d = await db();
      const tx = d.transaction([CHATS, META], "readwrite");
      tx.objectStore(CHATS).clear();
      tx.objectStore(META).clear();
      await done(tx);
    },
  };
}

/** Wrap `primary` so the first failure switches to memory for good (what
 *  was written to the broken store is simply not there). */
export function withMemoryFallback(primary: ChatCacheBackend | null): ChatCacheBackend {
  const mem = memoryBackend();
  if (!primary) return mem;
  let broken = false;
  const run = async <T>(op: (b: ChatCacheBackend) => Promise<T>): Promise<T> => {
    if (!broken) {
      try {
        return await op(primary);
      } catch (e) {
        broken = true;
        console.warn("[chat-cache] IndexedDB failed; memory only from here", e);
      }
    }
    return op(mem);
  };
  return {
    get kind() {
      return broken ? "memory" : primary.kind;
    },
    loadIndex: () => run((b) => b.loadIndex()),
    get: (k) => run((b) => b.get(k)),
    put: (e) => run((b) => b.put(e)),
    delete: (k) => run((b) => b.delete(k)),
    clear: () => run((b) => b.clear()),
  };
}
