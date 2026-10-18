import { describe, expect, it, vi } from "vitest";
import { createChatCache } from "./chatCache";
import {
  CHAT_CACHE_SCHEMA,
  memoryBackend,
  withMemoryFallback,
  type CachedChat,
  type ChatCacheBackend,
} from "./chatCacheBackend";
import type { ThreadMessage } from "./threadModel";

function msg(seq: number, text = `t${seq}`): ThreadMessage {
  return { id: `m${seq}`, seq, text, from: "a", at: seq, mine: false, kind: "text", choice: null };
}
const range = (n: number, text?: string) => Array.from({ length: n }, (_, i) => msg(i + 1, text));

/** A cache over `backend` whose debounce runs when `tick()` is called. */
function harness(backend: ChatCacheBackend, over: Parameters<typeof createChatCache>[0] = {}) {
  let t = 1000;
  const timers: (() => void)[] = [];
  const cache = createChatCache({
    backend: () => backend,
    now: () => (t += 1),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
    ...over,
  });
  return {
    cache,
    tick: () => {
      while (timers.length) timers.shift()?.();
    },
  };
}

const put = (cache: ReturnType<typeof createChatCache>, key: string, messages: ThreadMessage[], extra: Partial<{ conversationId: string | null; hasMore: boolean }> = {}) =>
  cache.remember({
    key,
    serverId: key.split("|")[0],
    messages,
    conversationId: extra.conversationId ?? "conv",
    hasMore: extra.hasMore ?? false,
  });

describe("chatCache", () => {
  it("memory first, synchronously", () => {
    const { cache } = harness(memoryBackend());
    put(cache, "s1|t:a", range(3));
    expect(cache.peek("s1|t:a")?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(cache.peek("s1|t:b")).toBeNull();
  });

  it("persists behind a debounce and reads back on a cold start (device)", async () => {
    const backend = memoryBackend();
    const a = harness(backend);
    put(a.cache, "s1|t:a", range(3), { conversationId: "c1", hasMore: true });
    expect(await backend.get("s1|t:a")).toBeNull(); // not yet written
    a.tick();
    await a.cache.flush();
    const row = await backend.get("s1|t:a");
    expect(row?.v).toBe(CHAT_CACHE_SCHEMA);
    expect(row?.bytes).toBeGreaterThan(0);

    // A new app start: nothing in memory, the device store answers.
    const b = harness(backend);
    expect(b.cache.peek("s1|t:a")).toBeNull();
    const hit = await b.cache.read("s1|t:a");
    expect(hit?.from).toBe("device");
    expect(hit?.entry.conversationId).toBe("c1");
    expect(hit?.entry.hasMore).toBe(true);
    expect(hit?.entry.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // ...and memory has it now.
    expect(b.cache.peek("s1|t:a")).not.toBeNull();
  });

  it("flush writes at once (backgrounding)", async () => {
    const backend = memoryBackend();
    const { cache } = harness(backend);
    put(cache, "s1|t:a", range(2));
    await cache.flush();
    expect(await backend.get("s1|t:a")).not.toBeNull();
  });

  it("keeps only the newest 100 messages per chat and marks older history", async () => {
    const { cache } = harness(memoryBackend());
    put(cache, "s1|t:a", range(130));
    const e = cache.peek("s1|t:a")!;
    expect(e.messages).toHaveLength(100);
    expect(e.messages[0].id).toBe("m31");
    expect(e.hasMore).toBe(true);
  });

  it("evicts the least recently saved chats past the chat cap", async () => {
    const backend = memoryBackend();
    const { cache, tick } = harness(backend, { maxChats: 3 });
    for (const k of ["a", "b", "c", "d", "e"]) put(cache, `s1|t:${k}`, range(2));
    tick();
    await cache.flush();
    const keys = (await backend.loadIndex()).map((m) => m.key).sort();
    expect(keys).toEqual(["s1|t:c", "s1|t:d", "s1|t:e"]);
  });

  it("evicts oldest past the byte budget", async () => {
    const backend = memoryBackend();
    const big = "x".repeat(4000);
    const { cache, tick } = harness(backend, { maxBytes: 10_000 });
    for (const k of ["a", "b", "c", "d"]) put(cache, `s1|t:${k}`, range(1, big));
    tick();
    await cache.flush();
    const idx = await backend.loadIndex();
    expect(idx.reduce((n, m) => n + m.bytes, 0)).toBeLessThanOrEqual(10_000);
    expect(idx.map((m) => m.key)).toContain("s1|t:d");
    expect(idx.map((m) => m.key)).not.toContain("s1|t:a");
  });

  it("keeps the memory LRU bounded", () => {
    const { cache } = harness(memoryBackend(), { memoryMax: 2 });
    put(cache, "s1|t:a", range(1));
    put(cache, "s1|t:b", range(1));
    cache.peek("s1|t:a"); // a is recent now
    put(cache, "s1|t:c", range(1));
    expect(cache.peek("s1|t:b")).toBeNull();
    expect(cache.peek("s1|t:a")).not.toBeNull();
  });

  it("an empty chat drops its entry", async () => {
    const backend = memoryBackend();
    const { cache } = harness(backend);
    put(cache, "s1|t:a", range(2));
    await cache.flush();
    put(cache, "s1|t:a", []);
    await cache.flush();
    expect(cache.peek("s1|t:a")).toBeNull();
    expect(await backend.get("s1|t:a")).toBeNull();
  });

  it("forgetServer wipes that server only (memory, pending writes, device)", async () => {
    const backend = memoryBackend();
    const { cache } = harness(backend);
    put(cache, "s1|t:a", range(2));
    put(cache, "s2|t:a", range(2));
    await cache.flush();
    put(cache, "s1|g:grp", range(1)); // pending write
    await cache.forgetServer("s1");
    await cache.flush();
    expect(cache.peek("s1|t:a")).toBeNull();
    expect(cache.peek("s1|g:grp")).toBeNull();
    expect(await backend.get("s1|t:a")).toBeNull();
    expect(await backend.get("s1|g:grp")).toBeNull();
    expect(await backend.get("s2|t:a")).not.toBeNull();
    expect(await cache.read("s1|t:a")).toBeNull();
  });

  it("a device read that started before a wipe does not bring the entry back", async () => {
    const backend = memoryBackend();
    const seed = harness(backend);
    put(seed.cache, "s1|t:a", range(2));
    await seed.cache.flush();
    const { cache } = harness(backend);
    const reading = cache.read("s1|t:a");
    const wiping = cache.forgetServer("s1");
    await wiping;
    expect(await reading).toBeNull();
    expect(cache.peek("s1|t:a")).toBeNull();
  });

  it("prune drops servers no longer saved; clearAll drops everything", async () => {
    const backend = memoryBackend();
    const { cache } = harness(backend);
    put(cache, "s1|t:a", range(1));
    put(cache, "s2|t:a", range(1));
    await cache.flush();
    await cache.prune(["s2"]);
    expect(await backend.get("s1|t:a")).toBeNull();
    expect(await backend.get("s2|t:a")).not.toBeNull();
    await cache.clearAll();
    expect(await backend.loadIndex()).toEqual([]);
    expect(cache.peek("s2|t:a")).toBeNull();
  });

  it("an entry from another schema version is dropped", async () => {
    const backend = memoryBackend();
    const stale = { v: CHAT_CACHE_SCHEMA + 1, key: "s1|t:a", serverId: "s1", messages: [], conversationId: null, hasMore: false, savedAt: 1, bytes: 1 } as CachedChat;
    await backend.put(stale);
    const { cache } = harness(backend);
    expect(await cache.read("s1|t:a")).toBeNull();
    await cache.flush();
    expect(await backend.get("s1|t:a")).toBeNull();
  });

  it("falls back to memory when the device store throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: ChatCacheBackend = {
      kind: "indexeddb",
      loadIndex: async () => {
        throw new Error("quota");
      },
      get: async () => {
        throw new Error("quota");
      },
      put: async () => {
        throw new Error("quota");
      },
      delete: async () => {
        throw new Error("quota");
      },
      clear: async () => {
        throw new Error("quota");
      },
    };
    const backend = withMemoryFallback(broken);
    const { cache } = harness(backend);
    put(cache, "s1|t:a", range(2));
    await cache.flush();
    expect(backend.kind).toBe("memory");
    expect(await backend.get("s1|t:a")).not.toBeNull();
    expect((await cache.stats()).backend).toBe("memory");
    warn.mockRestore();
  });

  it("no IndexedDB at all: memory backend", () => {
    expect(withMemoryFallback(null).kind).toBe("memory");
  });
});
