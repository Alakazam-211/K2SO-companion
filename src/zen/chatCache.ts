import {
  CHAT_CACHE_SCHEMA,
  indexedDbBackend,
  metaOf,
  withMemoryFallback,
  type CachedChat,
  type CachedChatMeta,
  type ChatCacheBackend,
} from "./chatCacheBackend";
import { CACHE_MAX_MESSAGES, cacheSlice } from "./threadCacheMerge";
import type { ThreadMessage } from "./threadModel";

// The chat cache (stale-while-revalidate): the newest messages of each
// chat (Thread or project chat) this phone has read, so opening it paints
// at once and the server read only corrects it.
//
//   memory   an LRU of `MEMORY_MAX_CHATS` chats, read synchronously on open;
//   device   IndexedDB (`chatCacheBackend`), the newest `CACHE_MAX_MESSAGES`
//            per chat, at most `CACHE_MAX_CHATS` chats and `CACHE_MAX_BYTES`
//            in all — the least recently saved go first. Written behind
//            (debounced) after each read or live frame; its index (keys,
//            sizes, ages) is read once, lazily, on first use.
//
// Keys are room keys (`threadRoomKey`: `<serverId>|t:<addr>` /
// `<serverId>|g:<groupId>`), so two servers never share an entry. A
// server's entries are wiped when it is removed, re-keyed or signed out;
// everything when no server is left.

export const MEMORY_MAX_CHATS = 40;
export const CACHE_MAX_CHATS = 150;
export const CACHE_MAX_BYTES = 15 * 1024 * 1024;
export const WRITE_DEBOUNCE_MS = 800;

export type CacheHit = { entry: CachedChat; from: "memory" | "device" };

export type RememberInput = {
  key: string;
  serverId: string;
  messages: ThreadMessage[];
  conversationId: string | null;
  hasMore: boolean;
};

export interface ChatCache {
  /** Memory only, synchronous (the open's first paint). */
  peek(key: string): CachedChat | null;
  /** Is `key` cached? Synchronous: true / false once the device index is
   *  loaded (or it is in memory), null while that is not known yet. */
  known(key: string): boolean | null;
  /** Memory, else the device store. */
  read(key: string): Promise<CacheHit | null>;
  /** Keep this copy (memory now, device after a short quiet). An empty
   *  chat drops its entry. */
  remember(input: RememberInput): void;
  /** Drop one chat (its access or the chat itself is gone). */
  forget(key: string): void;
  /** Load the device index now (app start, idle): the first open's
   *  device read is then one lookup. */
  warm(): void;
  /** Write what is pending now (the app is going to the background). */
  flush(): Promise<void>;
  /** Every cached chat key of `serverId` (memory and device), most
   *  recently saved first. */
  keysFor(serverId: string): Promise<string[]>;
  /** Drop every entry of `serverId` (memory and device). */
  forgetServer(serverId: string): Promise<void>;
  /** Drop entries of servers no longer saved. */
  prune(savedServerIds: string[]): Promise<void>;
  /** Drop everything. */
  clearAll(): Promise<void>;
  /** Diagnostics. */
  stats(): Promise<{ backend: string; memory: number; device: number; bytes: number }>;
}

type Opts = {
  backend?: () => ChatCacheBackend;
  now?: () => number;
  debounceMs?: number;
  maxChats?: number;
  maxBytes?: number;
  maxMessages?: number;
  memoryMax?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

function serverOfKey(key: string): string {
  const i = key.indexOf("|");
  return i < 0 ? "" : key.slice(0, i);
}

function validEntry(e: unknown, key: string): e is CachedChat {
  if (!e || typeof e !== "object") return false;
  const c = e as Partial<CachedChat>;
  return c.v === CHAT_CACHE_SCHEMA && c.key === key && Array.isArray(c.messages);
}

export function createChatCache(opts: Opts = {}): ChatCache {
  const now = opts.now ?? (() => Date.now());
  const debounceMs = opts.debounceMs ?? WRITE_DEBOUNCE_MS;
  const maxChats = opts.maxChats ?? CACHE_MAX_CHATS;
  const maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES;
  const maxMessages = opts.maxMessages ?? CACHE_MAX_MESSAGES;
  const memoryMax = opts.memoryMax ?? MEMORY_MAX_CHATS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const makeBackend = opts.backend ?? (() => withMemoryFallback(indexedDbBackend()));

  let backendInst: ChatCacheBackend | null = null;
  const backend = () => (backendInst ??= makeBackend());

  const memory = new Map<string, CachedChat>();
  const dirty = new Map<string, CachedChat>();
  let index: Map<string, CachedChatMeta> | null = null;
  let indexLoad: Promise<Map<string, CachedChatMeta>> | null = null;
  // Bumped per server on a wipe (and for all on clearAll): a read or write
  // that started before it must not bring the entry back.
  const epochs = new Map<string, number>();
  let globalEpoch = 0;
  const epochOf = (serverId: string) => `${globalEpoch}:${epochs.get(serverId) ?? 0}`;
  let timer: unknown = null;
  // Device work runs one step at a time (a wipe never races a write).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };

  function touch(entry: CachedChat): void {
    memory.delete(entry.key);
    memory.set(entry.key, entry);
    while (memory.size > memoryMax) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  }

  function ensureIndex(): Promise<Map<string, CachedChatMeta>> {
    if (index) return Promise.resolve(index);
    indexLoad ??= backend()
      .loadIndex()
      .catch(() => [] as CachedChatMeta[])
      .then((rows) => {
        // A wipe may have built an index meanwhile: it is newer.
        if (!index) index = new Map(rows.map((r) => [r.key, r]));
        return index;
      });
    return indexLoad;
  }

  async function evict(idx: Map<string, CachedChatMeta>): Promise<void> {
    let bytes = 0;
    for (const m of idx.values()) bytes += m.bytes || 0;
    if (idx.size <= maxChats && bytes <= maxBytes) return;
    const oldestFirst = [...idx.values()].sort((a, b) => a.savedAt - b.savedAt);
    const drop: string[] = [];
    let count = idx.size;
    for (const m of oldestFirst) {
      if (count <= maxChats && bytes <= maxBytes) break;
      drop.push(m.key);
      idx.delete(m.key);
      count -= 1;
      bytes -= m.bytes || 0;
    }
    if (drop.length) await backend().delete(drop);
  }

  async function writeOut(): Promise<void> {
    if (!dirty.size) return;
    const batch = [...dirty.values()];
    dirty.clear();
    const idx = await ensureIndex();
    // A wipe queued after this step deletes whatever it writes (serial).
    for (const e of batch) {
      const entry: CachedChat = { ...e, bytes: JSON.stringify(e.messages).length };
      try {
        await backend().put(entry);
        idx.set(entry.key, metaOf(entry));
      } catch {
        /* the fallback already took over */
      }
    }
    await evict(idx);
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void serial(writeOut);
    }, debounceMs);
  }

  const cache: ChatCache = {
    async keysFor(serverId) {
      const idx = await ensureIndex();
      const at = new Map<string, number>();
      for (const m of idx.values()) if (serverOfKey(m.key) === serverId) at.set(m.key, m.savedAt);
      for (const e of [...memory.values(), ...dirty.values()]) {
        if (e.serverId === serverId) at.set(e.key, Math.max(at.get(e.key) ?? 0, e.savedAt ?? 0));
      }
      return [...at.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    },
    peek(key) {
      const e = memory.get(key);
      if (!e) return null;
      touch(e);
      return e;
    },

    known(key) {
      if (memory.has(key) || dirty.has(key)) return true;
      return index ? index.has(key) : null;
    },

    async read(key) {
      const m = cache.peek(key);
      if (m) return { entry: m, from: "memory" };
      const server = serverOfKey(key);
      const epoch = epochOf(server);
      const idx = await ensureIndex();
      if (!idx.has(key)) return null;
      let row: CachedChat | null = null;
      try {
        row = await backend().get(key);
      } catch {
        row = null;
      }
      if (epochOf(server) !== epoch) return null;
      // Came into memory meanwhile (a read landed): that copy is newer.
      const raced = memory.get(key);
      if (raced) return { entry: raced, from: "memory" };
      if (!validEntry(row, key)) {
        idx.delete(key);
        void serial(() => backend().delete([key]));
        return null;
      }
      touch(row);
      return { entry: row, from: "device" };
    },

    remember({ key, serverId, messages, conversationId, hasMore }) {
      if (!key || !serverId) return;
      const slice = cacheSlice(messages, maxMessages);
      if (!slice.messages.length) {
        memory.delete(key);
        dirty.delete(key);
        if (index?.has(key)) {
          index.delete(key);
          void serial(() => backend().delete([key]));
        }
        return;
      }
      const entry: CachedChat = {
        v: CHAT_CACHE_SCHEMA,
        key,
        serverId,
        messages: slice.messages,
        conversationId: conversationId || null,
        hasMore: hasMore || slice.truncated,
        savedAt: now(),
        bytes: 0,
      };
      touch(entry);
      dirty.set(key, entry);
      schedule();
    },

    forget(key) {
      memory.delete(key);
      dirty.delete(key);
      void serial(async () => {
        const idx = await ensureIndex();
        idx.delete(key);
        await backend().delete([key]);
      });
    },

    warm() {
      void ensureIndex();
    },

    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      return serial(writeOut);
    },

    forgetServer(serverId) {
      if (!serverId) return Promise.resolve();
      epochs.set(serverId, (epochs.get(serverId) ?? 0) + 1);
      const prefix = `${serverId}|`;
      for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
      for (const k of [...dirty.keys()]) if (k.startsWith(prefix)) dirty.delete(k);
      return serial(async () => {
        const idx = await ensureIndex();
        const keys = [...idx.values()]
          .filter((m) => m.serverId === serverId || m.key.startsWith(prefix))
          .map((m) => m.key);
        for (const k of keys) idx.delete(k);
        await backend().delete(keys);
      });
    },

    prune(saved) {
      const keep = new Set(saved);
      return serial(async () => {
        const idx = await ensureIndex();
        const gone = [...idx.values()].filter((m) => !keep.has(m.serverId));
        for (const m of gone) {
          idx.delete(m.key);
          memory.delete(m.key);
        }
        await backend().delete(gone.map((m) => m.key));
      });
    },

    clearAll() {
      globalEpoch += 1;
      memory.clear();
      dirty.clear();
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      index = new Map();
      return serial(() => backend().clear());
    },

    async stats() {
      const idx = await ensureIndex();
      let bytes = 0;
      for (const m of idx.values()) bytes += m.bytes || 0;
      return { backend: backend().kind, memory: memory.size, device: idx.size, bytes };
    },
  };
  return cache;
}

let current: ChatCache | null = null;

/** The app's chat cache (created on first use). */
export function chatCache(): ChatCache {
  return (current ??= createChatCache());
}

/** Tests: swap in a fresh cache (memory backend unless given). */
export function setChatCacheForTests(cache: ChatCache | null): void {
  current = cache;
}
