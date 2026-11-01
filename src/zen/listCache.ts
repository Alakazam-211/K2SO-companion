import type { ChatSessions } from "./agentActivity";
import type { ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";

// Each server's lists on the device (Rosson 2026-11-01: "assume things are
// good"): the Agents and Home tabs paint from the last good read at once,
// and the server's answer replaces it a moment later (hydrateAgents). One
// IndexedDB row per server; a memory copy in front, so a second paint in
// the same session is synchronous. Never authoritative: a failed read
// keeps showing it under the usual "Reconnecting…" line, nothing more.

/** Bump to drop every saved list (an incompatible shape). */
export const LIST_CACHE_SCHEMA = 1;

export type CachedLists = {
  v: number;
  serverId: string;
  agents: StubAgent[];
  serverProjects: ServerProject[];
  chatSessions: ChatSessions;
  savedAt: number;
};

const DB_NAME = "k2-list-cache";
const STORE = "lists";
const WRITE_DELAY_MS = 1_000;

const mem = new Map<string, CachedLists>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let dbp: Promise<IDBDatabase> | null = null;
let broken = false;

function openDb(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new Error("no IndexedDB"));
      return;
    }
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(DB_NAME, LIST_CACHE_SCHEMA);
    } catch (e) {
      reject(e);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(STORE, { keyPath: "serverId" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    r.onblocked = () => reject(new Error("IndexedDB open blocked"));
  }));
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  if (broken) return null;
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const r = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
    });
  } catch (e) {
    broken = true;
    console.warn("[list-cache] IndexedDB failed; memory only from here", e);
    return null;
  }
}

/** This server's saved lists, or null. */
export async function readListCache(serverId: string): Promise<CachedLists | null> {
  if (!serverId) return null;
  const hit = mem.get(serverId);
  if (hit) return hit;
  const row = (await run("readonly", (s) => s.get(serverId))) as CachedLists | undefined | null;
  if (!row || row.v !== LIST_CACHE_SCHEMA || !Array.isArray(row.agents)) return null;
  if (!mem.has(serverId)) mem.set(serverId, row);
  return mem.get(serverId) ?? null;
}

/** Save a good read (memory now, the device a second later: list reads
 *  come in bursts). */
export function writeListCache(
  serverId: string,
  lists: Pick<CachedLists, "agents" | "serverProjects" | "chatSessions">,
  now = Date.now()
): void {
  if (!serverId) return;
  const row: CachedLists = { v: LIST_CACHE_SCHEMA, serverId, ...lists, savedAt: now };
  mem.set(serverId, row);
  const t = pending.get(serverId);
  if (t) clearTimeout(t);
  pending.set(
    serverId,
    setTimeout(() => {
      pending.delete(serverId);
      const latest = mem.get(serverId);
      if (latest) void run("readwrite", (s) => s.put(latest));
    }, WRITE_DELAY_MS)
  );
}

/** A removed or re-keyed server: its lists go too. */
export function dropListCache(serverId: string): void {
  mem.delete(serverId);
  const t = pending.get(serverId);
  if (t) clearTimeout(t);
  pending.delete(serverId);
  void run("readwrite", (s) => s.delete(serverId));
}

export function __resetListCacheForTests(): void {
  mem.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  dbp = null;
  broken = false;
}
