import { parseStashItem, type StashItem } from "./stashModel";

// The stash's on-device store: IndexedDB (records + attachment bytes), and
// an in-memory stand-in when IndexedDB is missing or throws (tests, a
// WebView without it). Not localStorage: attachments would overflow it.
// Same tiny wrapper shape as chatCacheBackend, but this is data, not a
// cache: an upgrade never drops a store.

/** Attachment bytes, kept by attachment id. */
export type StashBlob = { id: string; name: string; type: string; buf: ArrayBuffer };

export interface StashBackend {
  readonly kind: "indexeddb" | "memory";
  loadAll(): Promise<StashItem[]>;
  /** One transaction: the record and any new attachment bytes. */
  put(item: StashItem, blobs?: StashBlob[]): Promise<void>;
  /** Records and attachment bytes to remove, one transaction. */
  remove(itemIds: string[], blobIds: string[]): Promise<void>;
  getBlobs(ids: string[]): Promise<StashBlob[]>;
}

export function memoryStashBackend(): StashBackend {
  const items = new Map<string, StashItem>();
  const blobs = new Map<string, StashBlob>();
  return {
    kind: "memory",
    loadAll: async () => [...items.values()],
    put: async (item, bs = []) => {
      items.set(item.id, item);
      for (const b of bs) blobs.set(b.id, b);
    },
    remove: async (itemIds, blobIds) => {
      for (const id of itemIds) items.delete(id);
      for (const id of blobIds) blobs.delete(id);
    },
    getBlobs: async (ids) => ids.flatMap((id) => (blobs.has(id) ? [blobs.get(id)!] : [])),
  };
}

const DB_NAME = "k2-stash";
const DB_VERSION = 1;
const ITEMS = "items";
const BLOBS = "blobs";

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

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    r.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** IndexedDB, or null when this WebView has none. */
export function indexedDbStashBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB
): StashBackend | null {
  if (!factory) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb(factory));
  return {
    kind: "indexeddb",
    async loadAll() {
      const d = await db();
      const tx = d.transaction(ITEMS, "readonly");
      const rows = (await req(tx.objectStore(ITEMS).getAll())) as unknown[];
      return rows.flatMap((r) => {
        const item = parseStashItem(r);
        return item ? [item] : [];
      });
    },
    async put(item, blobs = []) {
      const d = await db();
      const tx = d.transaction([ITEMS, BLOBS], "readwrite");
      for (const b of blobs) tx.objectStore(BLOBS).put(b);
      tx.objectStore(ITEMS).put(item);
      await done(tx);
    },
    async remove(itemIds, blobIds) {
      if (!itemIds.length && !blobIds.length) return;
      const d = await db();
      const tx = d.transaction([ITEMS, BLOBS], "readwrite");
      for (const id of itemIds) tx.objectStore(ITEMS).delete(id);
      for (const id of blobIds) tx.objectStore(BLOBS).delete(id);
      await done(tx);
    },
    async getBlobs(ids) {
      if (!ids.length) return [];
      const d = await db();
      const tx = d.transaction(BLOBS, "readonly");
      const store = tx.objectStore(BLOBS);
      const rows = await Promise.all(ids.map((id) => req(store.get(id)) as Promise<StashBlob | undefined>));
      return rows.filter((r): r is StashBlob => !!r);
    },
  };
}
