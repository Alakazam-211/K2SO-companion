import { parseStashItem, type StashItem } from "./stashModel";

// The stash's on-device store: IndexedDB (records + attachment bytes).
// Not localStorage: attachments would overflow it. Same tiny wrapper shape
// as chatCacheBackend, but this is data, not a cache: an upgrade never
// drops a store, and there is no silent in-memory stand-in in the app (a
// save that can't be stored must fail, so the composer keeps the draft).
// The in-memory backend is for tests.

/** Attachment bytes, kept by attachment id. */
export type StashBlob = { id: string; name: string; type: string; buf: ArrayBuffer };

/** One change, one transaction: a save at the cap writes the new item,
 *  the oldest's tombstone and drops its bytes together. */
export type StashWrite = {
  put?: StashItem[];
  putBlobs?: StashBlob[];
  deleteItems?: string[];
  deleteBlobs?: string[];
};

export interface StashBackend {
  readonly kind: "indexeddb" | "memory";
  loadAll(): Promise<StashItem[]>;
  write(change: StashWrite): Promise<void>;
  getBlobs(ids: string[]): Promise<StashBlob[]>;
}

export function memoryStashBackend(): StashBackend {
  const items = new Map<string, StashItem>();
  const blobs = new Map<string, StashBlob>();
  return {
    kind: "memory",
    loadAll: async () => [...items.values()],
    write: async ({ put = [], putBlobs = [], deleteItems = [], deleteBlobs = [] }) => {
      for (const b of putBlobs) blobs.set(b.id, b);
      for (const i of put) items.set(i.id, i);
      for (const id of deleteItems) items.delete(id);
      for (const id of deleteBlobs) blobs.delete(id);
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

/** IndexedDB, or null when this WebView has none. After iOS suspends the
 *  app, WKWebView can lose the connection ("Connection to Indexed Database
 *  server lost"): a failed call drops it and tries once more on a fresh
 *  one, and a closed or upgraded connection is dropped at once. */
export function indexedDbStashBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB
): StashBackend | null {
  if (!factory) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= openDb(factory).then((d) => {
      d.onclose = () => {
        dbp = null;
      };
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      return d;
    }));
  const retry = async <T>(run: (d: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      return await run(await db());
    } catch {
      dbp = null;
      return run(await db());
    }
  };
  return {
    kind: "indexeddb",
    loadAll: () =>
      retry(async (d) => {
        const tx = d.transaction(ITEMS, "readonly");
        const rows = (await req(tx.objectStore(ITEMS).getAll())) as unknown[];
        return rows.flatMap((r) => {
          const item = parseStashItem(r);
          return item ? [item] : [];
        });
      }),
    write: ({ put = [], putBlobs = [], deleteItems = [], deleteBlobs = [] }) =>
      retry(async (d) => {
        const tx = d.transaction([ITEMS, BLOBS], "readwrite");
        for (const b of putBlobs) tx.objectStore(BLOBS).put(b);
        for (const i of put) tx.objectStore(ITEMS).put(i);
        for (const id of deleteItems) tx.objectStore(ITEMS).delete(id);
        for (const id of deleteBlobs) tx.objectStore(BLOBS).delete(id);
        await done(tx);
      }),
    getBlobs: (ids) =>
      ids.length
        ? retry(async (d) => {
            const tx = d.transaction(BLOBS, "readonly");
            const store = tx.objectStore(BLOBS);
            const rows = await Promise.all(ids.map((id) => req(store.get(id)) as Promise<StashBlob | undefined>));
            return rows.filter((r): r is StashBlob => !!r);
          })
        : Promise.resolve([]),
  };
}
