import { create } from "zustand";
import { onBootInfo } from "../api/scope";
import { onServerForget, serverHostKey, useServersStore, type ServerEntry } from "../stores/servers";

// Box ids for Home rows (K2 0.46.1 `homes-sync-v1`).
//
// A Home row used to be `handle::hostKey`. The host key is what THIS
// client calls the server: the laptop calls itself "local", the phone
// calls it "rosson.k2.dev", so a synced row could never match on both.
// K2 0.46.1 puts a stable `serverId` (16 hex) in `/boot-status`; rows
// become `handle::serverId`.
//
// This module remembers, per saved server (keyed by its id, MA2), the box
// id its `/boot-status` last reported. Every Home address rule reads it:
//   - `homeHostFor(entry)` — the host half a NEW row gets: the box id when
//     known, else the host key (an older daemon, or not read yet);
//   - `entryMatchesHomeHost` — a row resolves to a saved server by EITHER
//     form, so rows not yet migrated keep working;
//   - `canonicalHomeHost` — hostKey → box id when known (the migration and
//     the dedupe rule).
// Persisted in localStorage `k2.homes.serverIds.v1` so a cold start
// resolves rows before any `/boot-status` answers. Never throws.

export const HOME_SERVER_IDS_KEY = "k2.homes.serverIds.v1";

interface Persisted {
  /** Saved server id → box id. Dropped when that server is forgotten. */
  bySaved: Record<string, string>;
  /** Box id → the host key it was last seen under (labels for rows whose
   *  server is no longer saved). Kept on forget. */
  hostByBox: Record<string, string>;
}

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
    if (typeof s === "string" && s) out[k] = s;
  }
  return out;
}

function read(): Persisted {
  try {
    const raw = localStorage.getItem(HOME_SERVER_IDS_KEY);
    const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { bySaved: strMap(j.bySaved), hostByBox: strMap(j.hostByBox) };
  } catch {
    return { bySaved: {}, hostByBox: {} };
  }
}

function write(p: Persisted): void {
  try {
    localStorage.setItem(HOME_SERVER_IDS_KEY, JSON.stringify(p));
  } catch {
    /* lasts this session */
  }
}

interface HomeServerIdsState extends Persisted {
  note: (savedId: string, boxId: string, hostKey?: string) => void;
  forget: (savedId: string) => void;
  /** Re-read storage (tests). */
  reload: () => void;
}

export const useHomeServerIds = create<HomeServerIdsState>((set, get) => ({
  ...read(),
  note: (savedId, boxId, hostKey) => {
    const box = boxId.trim().toLowerCase();
    if (!savedId || !box) return;
    const host = (hostKey ?? "").trim().toLowerCase();
    const st = get();
    if (st.bySaved[savedId] === box && (!host || st.hostByBox[box] === host)) return;
    const next: Persisted = {
      bySaved: { ...st.bySaved, [savedId]: box },
      hostByBox: host ? { ...st.hostByBox, [box]: host } : st.hostByBox,
    };
    set(next);
    write(next);
  },
  forget: (savedId) => {
    const st = get();
    if (!(savedId in st.bySaved)) return;
    const { [savedId]: _gone, ...bySaved } = st.bySaved;
    const next = { bySaved, hostByBox: st.hostByBox };
    set(next);
    write(next);
  },
  reload: () => set(read()),
}));

// Learn box ids from every recorded `/boot-status` (pool, gates, taps).
onBootInfo((savedId, info) => {
  if (!info.serverId) return;
  const entry = useServersStore.getState().servers.find((s) => s.id === savedId);
  useHomeServerIds.getState().note(savedId, info.serverId, entry ? serverHostKey(entry) : undefined);
});

// A removed or re-keyed (maybe different daemon) server: its box id is no
// longer known for that saved id. Rows keep their address.
onServerForget((id) => useHomeServerIds.getState().forget(id));

/** The box id a saved server reported, or null. */
export function boxIdForSaved(savedId: string | null | undefined): string | null {
  if (!savedId) return null;
  return useHomeServerIds.getState().bySaved[savedId] ?? null;
}

type EntryLike = Pick<ServerEntry, "url"> & { id?: string; hostKey?: string };

/** The host half a new Home row gets for this saved server. */
export function homeHostFor(entry: EntryLike): string {
  return boxIdForSaved(entry.id) ?? serverHostKey(entry).toLowerCase();
}

/** Does a row's host (either form) name this saved server? */
export function entryMatchesHomeHost(entry: EntryLike, host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (serverHostKey(entry).toLowerCase() === h) return true;
  const box = boxIdForSaved(entry.id);
  return !!box && box === h;
}

/** A row host in its canonical form: a host key whose saved server has
 *  reported a box id becomes that box id; anything else stays. */
export function canonicalHomeHost(
  host: string,
  servers: ServerEntry[] = useServersStore.getState().servers
): string {
  const h = host.trim().toLowerCase();
  const { bySaved, hostByBox } = useHomeServerIds.getState();
  if (hostByBox[h] !== undefined || Object.values(bySaved).includes(h)) return h;
  for (const s of servers) {
    if (serverHostKey(s).toLowerCase() !== h) continue;
    const box = bySaved[s.id];
    if (box) return box;
  }
  return h;
}

/** Display fallback for a row whose server is not saved: the host key a
 *  box id was last seen under, else the host itself. */
export function homeHostLabel(host: string): string {
  const h = host.trim().toLowerCase();
  return useHomeServerIds.getState().hostByBox[h] ?? h;
}
