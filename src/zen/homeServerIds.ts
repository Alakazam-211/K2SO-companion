import { create } from "zustand";
import { onBootInfo, parseBoxServerId } from "../api/scope";
import { tryHostKey } from "../lib/hostKey";
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
//
// Besides each saved server's own `/boot-status` (the truth for that
// server), two hints fill hosts nothing has answered for: the sync
// server's pull `servers{hostKey: serverId}` map (`noteServerMap`) and a
// `/boot-status` `publicHost`. A saved server matching a hinted host gets
// that box id until its own `/boot-status` says otherwise, so its rows
// migrate even when the phone never read its boot-status.

export const HOME_SERVER_IDS_KEY = "k2.homes.serverIds.v1";

interface Persisted {
  /** Saved server id → box id. Dropped when that server is forgotten. */
  bySaved: Record<string, string>;
  /** Box id → the host key it was last seen under (labels for rows whose
   *  server is no longer saved). Kept on forget. */
  hostByBox: Record<string, string>;
  /** Host key → box id from a hint (the pull's `servers` map, a
   *  `publicHost`), for hosts no saved server's `/boot-status` covers. */
  hinted: Record<string, string>;
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
    return { bySaved: strMap(j.bySaved), hostByBox: strMap(j.hostByBox), hinted: strMap(j.hinted) };
  } catch {
    return { bySaved: {}, hostByBox: {}, hinted: {} };
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
  /** Hints: `{hostKey: boxId}` (the pull's `servers`, a `publicHost`).
   *  Fills saved servers with no box id yet; never overrides one. */
  hint: (map: Record<string, unknown>) => void;
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
      hinted: st.hinted,
    };
    set(next);
    write(next);
  },
  hint: (map) => {
    const st = get();
    let bySaved = st.bySaved;
    let hostByBox = st.hostByBox;
    let hinted = st.hinted;
    const servers = useServersStore.getState().servers;
    for (const [rawHost, rawBox] of Object.entries(map ?? {})) {
      const box = parseBoxServerId(rawBox);
      const host = tryHostKey(rawHost) ?? rawHost.trim().toLowerCase();
      if (!box || !host) continue;
      if (hinted[host] !== box) hinted = { ...hinted, [host]: box };
      if (hostByBox[box] === undefined) hostByBox = { ...hostByBox, [box]: host };
      for (const s of servers) {
        if (bySaved[s.id] === undefined && serverHostKey(s).toLowerCase() === host) bySaved = { ...bySaved, [s.id]: box };
      }
    }
    if (bySaved === st.bySaved && hostByBox === st.hostByBox && hinted === st.hinted) return;
    const next: Persisted = { bySaved, hostByBox, hinted };
    set(next);
    write(next);
  },
  forget: (savedId) => {
    const st = get();
    if (!(savedId in st.bySaved)) return;
    const { [savedId]: _gone, ...bySaved } = st.bySaved;
    const next = { bySaved, hostByBox: st.hostByBox, hinted: st.hinted };
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
  // The box's own public host names it too (another saved entry, or rows
  // written under that host).
  if (info.publicHost) useHomeServerIds.getState().hint({ [info.publicHost]: info.serverId });
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
  const key = serverHostKey(entry).toLowerCase();
  if (key === h) return true;
  const box = boxIdForSaved(entry.id) ?? useHomeServerIds.getState().hinted[key] ?? null;
  return !!box && box === h;
}

/** A row host in its canonical form: a host key whose saved server has
 *  reported a box id becomes that box id; anything else stays. */
export function canonicalHomeHost(
  host: string,
  servers: ServerEntry[] = useServersStore.getState().servers
): string {
  const h = host.trim().toLowerCase();
  const { bySaved, hostByBox, hinted } = useHomeServerIds.getState();
  if (hostByBox[h] !== undefined || Object.values(bySaved).includes(h)) return h;
  for (const s of servers) {
    if (serverHostKey(s).toLowerCase() !== h) continue;
    const box = bySaved[s.id];
    if (box) return box;
  }
  return hinted[h] ?? h;
}

/** Display fallback for a row whose server is not saved: the host key a
 *  box id was last seen under, else the host itself. */
export function homeHostLabel(host: string): string {
  const h = host.trim().toLowerCase();
  return useHomeServerIds.getState().hostByBox[h] ?? h;
}
