import { create } from "zustand";
import { parseRowAddress } from "./multi/merge";
import { canonicalHomeHost } from "./homeServerIds";
import {
  diffLocal,
  pruneTombstones,
  resolveHomeId,
  withOrderKeys,
  withTombstones,
  migrateHomeAddresses,
  type ChangeItem,
  type SyncState,
  type Tombstone,
} from "./homesMerge";

// My Home (multi-server PRD §14 HM2): named, ordered lists of agents drawn
// from any saved server. Lives on this device only, in localStorage
// `k2.homes.v1`, in desktop's shape (`K2/src/renderer/stores/homes.ts`):
//   {version: 1, homes: [{id, name, rows: [{address, workspaceId, label}]}]}
// A row's key is `handle::hostKey`, lowercase (`lib/home-address.ts`); the
// host key comes from `lib/hostKey.ts`. Desktop Homes are not imported
// (no sync, PRD NG1). A server switch never changes a Home.
//
// Homes sync (K2 0.46.1 `homes-sync-v1`, `./homesSync`): the doc stays
// `version: 1` and gains optional fields old readers ignore — `order`
// (fractional index), `updatedAt` / `by` on every Home and row, plus
// `tombstones` and `redirects` (first-sync id merges). Every local edit
// goes through `commit`, which stamps what changed and hands the changes
// to the sync engine (`onHomesLocalChange`). This copy is always the
// working copy: sync never blocks it. Row hosts may be a host key (old)
// or the box's `serverId` (`./homeServerIds`); both resolve.
//
// Storage can throw (private mode, quota). Every read and write is in
// try/catch; a failure leaves the in-memory Homes working. A stored value
// that parses but is not ours is not overwritten until the user changes a
// Home.

export const HOMES_STORAGE_KEY = "k2.homes.v1";
export const HOMES_LAST_SELECTED_KEY = "k2.homes.lastSelected";
/** This device's Agents / Home tab under the Agents list (HM1). */
export const LIST_TAB_KEY = "k2.zen.listTab";
export const DEFAULT_HOME_NAME = "Home";
export const HOME_NAME_MAX = 60;

export type ListTab = "agents" | "home";

export interface HomeRow {
  /** `handle::host`, lowercase — the row key. `host` is the box's
   *  `serverId` once known, else the host key. */
  address: string;
  /** `projects.id` on that host — rename-repair hint, not identity. */
  workspaceId: string | null;
  /** Display name when the row was added. */
  label: string;
  /** Sync (optional; absent on rows saved before sync). */
  order?: string;
  updatedAt?: number;
  by?: string;
}

export interface Home {
  id: string;
  name: string;
  rows: HomeRow[];
  order?: string;
  updatedAt?: number;
  by?: string;
}

export interface HomesDoc {
  version: 1;
  homes: Home[];
  /** Deleted Homes / rows, kept 90 days (sync). */
  tombstones?: Tombstone[];
  /** Local Home id → server id after a first-sync merge. */
  redirects?: Record<string, string>;
}

// ─── Storage (never throws) ───

function lsGet(key: string): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: localStorage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: Homes stay in memory */
  }
}

/** Agents is the default (HM1): no Home can come from another device yet. */
export function readListTab(): ListTab {
  const r = lsGet(LIST_TAB_KEY);
  return r.ok && r.value === "home" ? "home" : "agents";
}

export function writeListTab(tab: ListTab): void {
  lsSet(LIST_TAB_KEY, tab);
}

// ─── Addresses (desktop `lib/home-address.ts`) ───

/** `handle::host`, lowercase. The merged list's `rowAddress` (multi-server
 *  MS15) spells the same address for a lowercase handle; host keys come
 *  from the one rule in `stores/servers` `serverHostKey` (MS1, MA1). */
export function homeAddress(handle: string, hostKey: string): string {
  return `${handle.trim().toLowerCase()}::${hostKey.trim().toLowerCase()}`;
}

/** Parse a row address with the merged list's rule (`parseRowAddress`:
 *  a bracketed IPv6 host keeps its `::`). Null for anything that is not
 *  `<handle>::<host>`. */
export function parseHomeAddress(address: string): { handle: string; host: string } | null {
  const parts = parseRowAddress(address.trim().toLowerCase());
  if (!parts || !parts.handle || !parts.hostKey) return null;
  return { handle: parts.handle, host: parts.hostKey };
}

// ─── Pure doc edits ───

function optStamp(r: Record<string, unknown>): boolean {
  return (
    (r.order === undefined || typeof r.order === "string") &&
    (r.updatedAt === undefined || typeof r.updatedAt === "number") &&
    (r.by === undefined || typeof r.by === "string")
  );
}

function isRow(v: unknown): v is HomeRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.address === "string" &&
    parseHomeAddress(r.address) !== null &&
    (r.workspaceId === null || typeof r.workspaceId === "string") &&
    typeof r.label === "string" &&
    optStamp(r)
  );
}

function isTombstone(v: unknown): v is Tombstone {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t.updatedAt !== "number") return false;
  if (t.kind === "home") return typeof t.id === "string";
  return t.kind === "row" && typeof t.homeId === "string" && typeof t.address === "string";
}

function isHome(v: unknown): v is Home {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    h.id.length > 0 &&
    typeof h.name === "string" &&
    Array.isArray(h.rows) &&
    h.rows.every(isRow) &&
    optStamp(h)
  );
}

/** A stored `k2.homes.v1` value. Null when missing or not a version-1 doc
 *  with at least one Home. */
export function parseHomesDoc(raw: string | null): HomesDoc | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (d.version !== 1 || !Array.isArray(d.homes) || d.homes.length === 0) return null;
  if (!d.homes.every(isHome)) return null;
  const doc: HomesDoc = { version: 1, homes: d.homes as Home[] };
  if (Array.isArray(d.tombstones)) doc.tombstones = d.tombstones.filter(isTombstone);
  if (d.redirects && typeof d.redirects === "object") {
    const redirects: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.redirects as Record<string, unknown>)) {
      if (typeof v === "string" && v) redirects[k] = v;
    }
    doc.redirects = redirects;
  }
  return doc;
}

/** A row address in its canonical form: its host becomes the box's
 *  `serverId` when this phone knows it (`./homeServerIds`). */
export function canonicalHomeAddress(address: string): string {
  const key = address.trim().toLowerCase();
  const p = parseHomeAddress(key);
  if (!p) return key;
  const host = canonicalHomeHost(p.host);
  return host === p.host ? key : `${p.handle}::${host}`;
}

/** Trim + cap a Home name. Null for an empty name (refused). */
export function cleanHomeName(name: string): string | null {
  const t = name.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, HOME_NAME_MAX) : null;
}

/** True when `address` is already on that Home. */
export function homeHasAddress(home: Home | null | undefined, address: string): boolean {
  if (!home) return false;
  const key = address.trim().toLowerCase();
  const canon = canonicalHomeAddress(key);
  return home.rows.some((r) => r.address === key || canonicalHomeAddress(r.address) === canon);
}

/** Add a row (deduped by address). Null when nothing changed. */
export function withRowAdded(homes: Home[], homeId: string, row: HomeRow): Home[] | null {
  const address = row.address.trim().toLowerCase();
  if (!parseHomeAddress(address)) return null;
  const home = homes.find((h) => h.id === homeId);
  if (!home || homeHasAddress(home, address)) return null;
  return homes.map((h) =>
    h.id === homeId ? { ...h, rows: [...h.rows, { ...row, address }] } : h
  );
}

export function withRowRemoved(homes: Home[], homeId: string, address: string): Home[] | null {
  const key = address.trim().toLowerCase();
  const home = homes.find((h) => h.id === homeId);
  if (!home || !homeHasAddress(home, key)) return null;
  // Either spelling of the same agent (host key / box id) comes off.
  const canon = canonicalHomeAddress(key);
  return homes.map((h) =>
    h.id === homeId
      ? { ...h, rows: h.rows.filter((r) => r.address !== key && canonicalHomeAddress(r.address) !== canon) }
      : h
  );
}

export function withRowMoved(homes: Home[], homeId: string, from: number, to: number): Home[] | null {
  const home = homes.find((h) => h.id === homeId);
  if (!home) return null;
  const n = home.rows.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return null;
  const rows = [...home.rows];
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  return homes.map((h) => (h.id === homeId ? { ...h, rows } : h));
}

/** Rename repair over every Home (desktop `repairRows`): `resolve` maps a
 *  row to its fresh `{address, workspaceId, label}`, or null to leave it.
 *  A repaired address already on the same Home drops the stale row; two
 *  stale rows that repair to one address keep the first. Null when
 *  nothing changed. */
export function withRowsRepaired(homes: Home[], resolve: (row: HomeRow) => HomeRow | null): Home[] | null {
  let changed = false;
  const next = homes.map((h) => {
    let rows: HomeRow[] = [];
    let homeChanged = false;
    for (const r of h.rows) {
      const fresh = resolve(r);
      if (
        !fresh ||
        (fresh.address === r.address && fresh.workspaceId === r.workspaceId && fresh.label === r.label)
      ) {
        rows.push(r);
        continue;
      }
      const address = fresh.address.trim().toLowerCase();
      if (!parseHomeAddress(address)) {
        rows.push(r);
        continue;
      }
      homeChanged = true;
      if (address !== r.address && h.rows.some((o) => o.address === address)) continue;
      rows.push({ ...fresh, address });
    }
    if (!homeChanged) return h;
    changed = true;
    const seen = new Set<string>();
    rows = rows.filter((r) => (seen.has(r.address) ? false : (seen.add(r.address), true)));
    return { ...h, rows };
  });
  return changed ? next : null;
}

// ─── Store ───

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedHomes(): Home[] {
  return [{ id: newId(), name: DEFAULT_HOME_NAME, rows: [] }];
}

// ─── Sync hooks (the engine in `./homesSync` sets these) ───

type ChangeSink = (changes: ChangeItem[]) => void;
const changeSinks = new Set<ChangeSink>();
let writerId = "";

/** Hear every local edit's stamped changes (the sync outbox). */
export function onHomesLocalChange(fn: ChangeSink): () => void {
  changeSinks.add(fn);
  return () => {
    changeSinks.delete(fn);
  };
}

/** This device's id, stamped as `by` on every local write (LWW tie-break). */
export function setHomesWriterId(id: string): void {
  writerId = id;
}

function emitChanges(changes: ChangeItem[]): void {
  if (changes.length === 0) return;
  for (const fn of [...changeSinks]) {
    try {
      fn(changes);
    } catch {
      /* the sync engine never breaks a Home edit */
    }
  }
}

export interface HomesState {
  homes: Home[];
  /** The Home on screen (always one of `homes`). */
  selectedId: string;
  /** True once `k2.homes.v1` holds our doc (read, or the seed written). */
  stored: boolean;
  /** Deleted Homes / rows (sync), younger than 90 days. */
  tombstones: Tombstone[];
  /** Local Home id → server id (first-sync merges). */
  redirects: Record<string, string>;
  /** First open of the Home tab: write the "Home" seed if storage has none. */
  ensureSeeded: () => void;
  selectHome: (id: string) => void;
  /** Create an empty Home and select it. Null when the name is empty. */
  createHome: (name: string) => string | null;
  /** False when the name is empty or the Home is gone. */
  renameHome: (id: string, name: string) => boolean;
  /** False for the last Home (never deleted) or an unknown id. */
  deleteHome: (id: string) => boolean;
  /** False when the address is already on that Home (dedupe per Home). */
  addRow: (homeId: string, row: HomeRow) => boolean;
  removeRow: (homeId: string, address: string) => void;
  moveRow: (homeId: string, from: number, to: number) => void;
  /** Rename repair on every Home (`withRowsRepaired`). Writes only when a
   *  row changed. */
  repairRows: (resolve: (row: HomeRow) => HomeRow | null) => void;
  /** hostKey → box id on every row (a local edit: queued when syncing). */
  migrateAddresses: () => boolean;
  /** Replace the Homes with a sync result (no stamping, no changes out).
   *  An empty result keeps one Home (seeded as a local edit). */
  applySynced: (state: SyncState) => void;
  /** Sync's view of the Homes. */
  syncState: () => SyncState;
  /** Re-read storage (tests; another window never writes on the phone). */
  reload: () => void;
}

type Loaded = Pick<HomesState, "homes" | "selectedId" | "stored" | "tombstones" | "redirects"> & {
  raw: "missing" | "ours" | "foreign" | "error";
};

function load(): Loaded {
  const r = lsGet(HOMES_STORAGE_KEY);
  const doc = r.ok ? parseHomesDoc(r.value) : null;
  // Rows saved before sync get order keys in memory (no stamp: any synced
  // write beats them); the next edit writes them.
  const homes = withOrderKeys(doc?.homes ?? seedHomes()) as Home[];
  const redirects = doc?.redirects ?? {};
  const last = lsGet(HOMES_LAST_SELECTED_KEY);
  const want = last.ok && last.value ? resolveHomeId(redirects, last.value) : null;
  const selectedId = homes.some((h) => h.id === want) ? (want as string) : homes[0].id;
  const raw = !r.ok ? "error" : doc ? "ours" : r.value === null ? "missing" : "foreign";
  return {
    homes,
    selectedId,
    stored: !!doc,
    tombstones: pruneTombstones(doc?.tombstones ?? [], Date.now()),
    redirects,
    raw,
  };
}

let rawState: Loaded["raw"] = "missing";

function initial(): Omit<Loaded, "raw"> {
  const l = load();
  rawState = l.raw;
  const { raw: _raw, ...rest } = l;
  return rest;
}

export const useHomesStore = create<HomesState>((set, get) => {
  const write = (
    homes: Home[],
    selectedId: string,
    tombstones: Tombstone[],
    redirects: Record<string, string>
  ) => {
    const sel = homes.some((h) => h.id === selectedId) ? selectedId : homes[0].id;
    const doc: HomesDoc = { version: 1, homes };
    if (tombstones.length > 0) doc.tombstones = tombstones;
    if (Object.keys(redirects).length > 0) doc.redirects = redirects;
    lsSet(HOMES_STORAGE_KEY, JSON.stringify(doc));
    lsSet(HOMES_LAST_SELECTED_KEY, sel);
    rawState = "ours";
    set({ homes, selectedId: sel, stored: true, tombstones, redirects });
  };
  /** A local edit: stamp what changed, tombstone what went, tell sync. */
  const commit = (
    next: Home[],
    selectedId = get().selectedId,
    base: Pick<HomesState, "homes" | "tombstones" | "redirects"> = get()
  ) => {
    const now = Date.now();
    const diff = diffLocal(base.homes, next, { now, by: writerId });
    const tombstones = pruneTombstones(
      withTombstones(base.tombstones, diff.tombstones, diff.revived),
      now
    );
    write(diff.homes as Home[], selectedId, tombstones, base.redirects);
    emitChanges(diff.changes);
  };
  return {
    ...initial(),
    ensureSeeded: () => {
      // Never overwrite a value we could not read or do not recognise.
      if (get().stored || rawState !== "missing") return;
      commit(get().homes);
    },
    selectHome: (want) => {
      const id = resolveHomeId(get().redirects, want);
      if (!get().homes.some((h) => h.id === id)) return;
      lsSet(HOMES_LAST_SELECTED_KEY, id);
      set({ selectedId: id });
    },
    createHome: (name) => {
      const clean = cleanHomeName(name);
      if (!clean) return null;
      const id = newId();
      commit([...get().homes, { id, name: clean, rows: [] }], id);
      return id;
    },
    renameHome: (want, name) => {
      const id = resolveHomeId(get().redirects, want);
      const clean = cleanHomeName(name);
      if (!clean || !get().homes.some((h) => h.id === id)) return false;
      commit(get().homes.map((h) => (h.id === id ? { ...h, name: clean } : h)));
      return true;
    },
    deleteHome: (want) => {
      const id = resolveHomeId(get().redirects, want);
      const homes = get().homes;
      if (homes.length <= 1 || !homes.some((h) => h.id === id)) return false;
      const i = homes.findIndex((h) => h.id === id);
      const next = homes.filter((h) => h.id !== id);
      const sel = get().selectedId === id ? next[Math.max(0, i - 1)].id : get().selectedId;
      commit(next, sel);
      return true;
    },
    addRow: (homeId, row) => {
      const next = withRowAdded(get().homes, resolveHomeId(get().redirects, homeId), row);
      if (!next) return false;
      commit(next);
      return true;
    },
    removeRow: (homeId, address) => {
      const next = withRowRemoved(get().homes, resolveHomeId(get().redirects, homeId), address);
      if (next) commit(next);
    },
    moveRow: (homeId, from, to) => {
      const next = withRowMoved(get().homes, resolveHomeId(get().redirects, homeId), from, to);
      if (next) commit(next);
    },
    repairRows: (resolve) => {
      const next = withRowsRepaired(get().homes, resolve);
      if (next) commit(next);
    },
    migrateAddresses: () => {
      const next = migrateHomeAddresses(get().homes, canonicalHomeAddress);
      if (!next) return false;
      // Never overwrite storage we could not read or do not recognise.
      if (!get().stored && rawState !== "missing") return false;
      commit(next as Home[]);
      return true;
    },
    applySynced: (state) => {
      const sel = resolveHomeId(state.redirects, get().selectedId);
      const tombstones = pruneTombstones(state.tombstones, Date.now());
      if (state.homes.length === 0) {
        // Every Home was deleted elsewhere: keep one, as a local edit.
        commit(seedHomes(), sel, { homes: [], tombstones, redirects: state.redirects });
        return;
      }
      write(state.homes as Home[], sel, tombstones, state.redirects);
    },
    syncState: () => ({ homes: get().homes, tombstones: get().tombstones, redirects: get().redirects }),
    reload: () => set(initial()),
  };
});

/** The Home on screen. */
export function selectedHome(s: Pick<HomesState, "homes" | "selectedId">): Home {
  return s.homes.find((h) => h.id === s.selectedId) ?? s.homes[0];
}
