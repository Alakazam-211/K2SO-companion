import { create } from "zustand";
import { parseRowAddress } from "./multi/merge";

// My Home (multi-server PRD §14 HM2): named, ordered lists of agents drawn
// from any saved server. Lives on this device only, in localStorage
// `k2.homes.v1`, in desktop's shape (`K2/src/renderer/stores/homes.ts`):
//   {version: 1, homes: [{id, name, rows: [{address, workspaceId, label}]}]}
// A row's key is `handle::hostKey`, lowercase (`lib/home-address.ts`); the
// host key comes from `lib/hostKey.ts`. Desktop Homes are not imported
// (no sync, PRD NG1). A server switch never changes a Home.
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
  /** `handle::host`, lowercase — the row key. */
  address: string;
  /** `projects.id` on that host — rename-repair hint, not identity. */
  workspaceId: string | null;
  /** Display name when the row was added. */
  label: string;
}

export interface Home {
  id: string;
  name: string;
  rows: HomeRow[];
}

export interface HomesDoc {
  version: 1;
  homes: Home[];
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

function isRow(v: unknown): v is HomeRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.address === "string" &&
    parseHomeAddress(r.address) !== null &&
    (r.workspaceId === null || typeof r.workspaceId === "string") &&
    typeof r.label === "string"
  );
}

function isHome(v: unknown): v is Home {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    h.id.length > 0 &&
    typeof h.name === "string" &&
    Array.isArray(h.rows) &&
    h.rows.every(isRow)
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
  return { version: 1, homes: d.homes as Home[] };
}

/** Trim + cap a Home name. Null for an empty name (refused). */
export function cleanHomeName(name: string): string | null {
  const t = name.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, HOME_NAME_MAX) : null;
}

/** True when `address` is already on that Home. */
export function homeHasAddress(home: Home | null | undefined, address: string): boolean {
  const key = address.trim().toLowerCase();
  return !!home && home.rows.some((r) => r.address === key);
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
  return homes.map((h) =>
    h.id === homeId ? { ...h, rows: h.rows.filter((r) => r.address !== key) } : h
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

// ─── Store ───

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedHomes(): Home[] {
  return [{ id: newId(), name: DEFAULT_HOME_NAME, rows: [] }];
}

export interface HomesState {
  homes: Home[];
  /** The Home on screen (always one of `homes`). */
  selectedId: string;
  /** True once `k2.homes.v1` holds our doc (read, or the seed written). */
  stored: boolean;
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
  /** Re-read storage (tests; another window never writes on the phone). */
  reload: () => void;
}

type Loaded = Pick<HomesState, "homes" | "selectedId" | "stored"> & { raw: "missing" | "ours" | "foreign" | "error" };

function load(): Loaded {
  const r = lsGet(HOMES_STORAGE_KEY);
  const doc = r.ok ? parseHomesDoc(r.value) : null;
  const homes = doc?.homes ?? seedHomes();
  const last = lsGet(HOMES_LAST_SELECTED_KEY);
  const want = last.ok ? last.value : null;
  const selectedId = homes.some((h) => h.id === want) ? (want as string) : homes[0].id;
  const raw = !r.ok ? "error" : doc ? "ours" : r.value === null ? "missing" : "foreign";
  return { homes, selectedId, stored: !!doc, raw };
}

let rawState: Loaded["raw"] = "missing";

function initial(): Pick<HomesState, "homes" | "selectedId" | "stored"> {
  const l = load();
  rawState = l.raw;
  return { homes: l.homes, selectedId: l.selectedId, stored: l.stored };
}

export const useHomesStore = create<HomesState>((set, get) => {
  const commit = (homes: Home[], selectedId = get().selectedId) => {
    const sel = homes.some((h) => h.id === selectedId) ? selectedId : homes[0].id;
    lsSet(HOMES_STORAGE_KEY, JSON.stringify({ version: 1, homes } satisfies HomesDoc));
    lsSet(HOMES_LAST_SELECTED_KEY, sel);
    rawState = "ours";
    set({ homes, selectedId: sel, stored: true });
  };
  return {
    ...initial(),
    ensureSeeded: () => {
      // Never overwrite a value we could not read or do not recognise.
      if (get().stored || rawState !== "missing") return;
      commit(get().homes);
    },
    selectHome: (id) => {
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
    renameHome: (id, name) => {
      const clean = cleanHomeName(name);
      if (!clean || !get().homes.some((h) => h.id === id)) return false;
      commit(get().homes.map((h) => (h.id === id ? { ...h, name: clean } : h)));
      return true;
    },
    deleteHome: (id) => {
      const homes = get().homes;
      if (homes.length <= 1 || !homes.some((h) => h.id === id)) return false;
      const i = homes.findIndex((h) => h.id === id);
      const next = homes.filter((h) => h.id !== id);
      const sel = get().selectedId === id ? next[Math.max(0, i - 1)].id : get().selectedId;
      commit(next, sel);
      return true;
    },
    addRow: (homeId, row) => {
      const next = withRowAdded(get().homes, homeId, row);
      if (!next) return false;
      commit(next);
      return true;
    },
    removeRow: (homeId, address) => {
      const next = withRowRemoved(get().homes, homeId, address);
      if (next) commit(next);
    },
    moveRow: (homeId, from, to) => {
      const next = withRowMoved(get().homes, homeId, from, to);
      if (next) commit(next);
    },
    reload: () => set(initial()),
  };
});

/** The Home on screen. */
export function selectedHome(s: Pick<HomesState, "homes" | "selectedId">): Home {
  return s.homes.find((h) => h.id === s.selectedId) ?? s.homes[0];
}
