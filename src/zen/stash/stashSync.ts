import { create } from "zustand";
import { getBootStatus } from "../../api/client";
import { registerHomesDevice, type SyncFailure } from "../../api/homesSync";
import { scopeFor } from "../../api/scope";
import { onServerSignal } from "../../api/serverSignals";
import { FEATURE_STASH_SYNC, onStashFrame, pullStash, pushStash, stashPushBatches } from "../../api/stashSync";
import { homesDeviceId, homesDeviceInfo, retryDelayMs, PUSH_DEBOUNCE_MS, useHomesSyncStore } from "../homesSync";
import { isOwnSchema, stashWins, type StashItem } from "./stashModel";
import { onStashLocalChange, useStashStore } from "./stashStore";

// Prompt stash sync (K2 0.46.7 `stash-sync-v1`, pinned contract
// 2026-10-30). Rides on Home sync: the same server (the one the person
// picked for Home), the same device registration, the same socket. With
// Home sync off, or a server without `stash-sync-v1`, the stash stays on
// this phone only.
//
// LOCAL-FIRST, like Homes: the stash store is always the working copy;
// nothing here blocks a save or empties the list.
//   - every local save / delete queues the record's id (the outbox,
//     `k2.stash.sync.v1`) and pushes shortly after; the push sends each
//     record as it is now (the latest write wins);
//   - a run = push the outbox (≤ 200 records / < 4 MiB a push; 409
//     `device_not_registered`: register in the Homes registry and retry
//     once) → pull since the cursor and merge per id with the contract's
//     rule (stashWins);
//       · `cap_reached`: the record stays here and in the outbox, shown
//         as not synced, and goes again after the next local change
//         (the person removed something);
//       · any other rejection leaves the outbox, shown as not synced;
//       · `superseded`: the next pull is a full one so the winner comes;
//       · a `full:true` pull is the whole live set: a record here that
//         is not in it and not waiting in the outbox was deleted
//         elsewhere (its tombstone aged out) and goes;
//   - first sync with a server (or a new one): every record here joins
//     the outbox, so nothing local is lost to the full pull; files saved
//     before sync (no device_id) are claimed for this phone first;
//   - runs on: a local change, a `stash_changed` frame with another
//     cursor, the app coming to the foreground, the server coming back,
//     Home sync turning on, and a backoff retry after a failure;
//   - 410 `device_removed`: stop (Home sync stops too and says so).

export const STASH_SYNC_KEY = "k2.stash.sync.v1";

export type StashSyncStatus = "off" | "syncing" | "synced" | "offline" | "error";

type Meta = {
  serverId: string;
  cursor: number | null;
  /** Record ids changed here that the server has not taken yet. */
  outbox: string[];
  /** Record id → the server's reason it was refused. */
  unsynced: Record<string, string>;
};

interface StashSyncState {
  status: StashSyncStatus;
  error: string | null;
  unsynced: Record<string, string>;
}

export const useStashSyncStore = create<StashSyncState>(() => ({
  status: "off",
  error: null,
  unsynced: readMeta()?.unsynced ?? {},
}));

function readMeta(): Meta | null {
  try {
    const j = JSON.parse(localStorage.getItem(STASH_SYNC_KEY) ?? "null");
    if (!j || typeof j.serverId !== "string") return null;
    return {
      serverId: j.serverId,
      cursor: Number.isInteger(j.cursor) ? j.cursor : null,
      outbox: Array.isArray(j.outbox) ? j.outbox.filter((x: unknown) => typeof x === "string") : [],
      unsynced: j.unsynced && typeof j.unsynced === "object" ? j.unsynced : {},
    };
  } catch {
    return null;
  }
}

let meta: Meta | null = readMeta();

function saveMeta(next: Meta): void {
  meta = next;
  try {
    localStorage.setItem(STASH_SYNC_KEY, JSON.stringify(next));
  } catch {
    /* lasts this session */
  }
  if (useStashSyncStore.getState().unsynced !== next.unsynced) useStashSyncStore.setState({ unsynced: next.unsynced });
}

/** The meta for `serverId`; a new server starts with everything here
 *  queued (the first pull is full: nothing local may be lost to it). */
function metaFor(serverId: string): Meta {
  if (meta && meta.serverId === serverId) return meta;
  const all = useStashStore
    .getState()
    .items.filter(isOwnSchema)
    .map((i) => i.id);
  const fresh = { serverId, cursor: null, outbox: all, unsynced: {} };
  saveMeta(fresh);
  return fresh;
}

const put = (p: Partial<StashSyncState>) => useStashSyncStore.setState(p);
const syncServer = () => useHomesSyncStore.getState().serverId;

// ─── Timers ───

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on stop: a run from before quits. */
let gen = 0;
/** A local change since the last push: records the server refused as
 *  full (`cap_reached`) go again only then, not on every run. */
let roomMaybe = true;

function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (pushTimer) clearTimeout(pushTimer);
  retryTimer = pushTimer = null;
}

function scheduleRetry(): void {
  if (retryTimer || !syncServer()) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncStashNow();
  }, retryDelayMs(retryAttempt++));
}

function noteFailure(f: SyncFailure): void {
  if (f.kind === "removed") {
    // Home sync gets the same 410 and turns off (with its notice).
    put({ status: "off", error: null });
    return;
  }
  if (f.kind === "offline") put({ status: "offline", error: null });
  else put({ status: "error", error: f.error });
  scheduleRetry();
}

// ─── One run ───

/** Records as sent vs now: still the same version (not edited since)? */
const sameVersion = (a: StashItem, b: StashItem) =>
  a.updated_at === b.updated_at && a.deleted_at === b.deleted_at && a.updated_by === b.updated_by;

async function runOnce(): Promise<void> {
  const serverId = syncServer();
  if (!serverId) {
    put({ status: "off", error: null });
    return;
  }
  const myGen = gen;
  const live = () => gen === myGen && syncServer() === serverId;
  const scope = scopeFor(serverId);
  let token = "";
  try {
    token = scope.token();
  } catch {
    return;
  }
  if (!token) return;
  const boot = await getBootStatus(scope);
  if (!live()) return;
  if (!boot || boot.featuresKnown === false) {
    put({ status: "offline", error: null });
    scheduleRetry();
    return;
  }
  if (!boot.features.includes(FEATURE_STASH_SYNC)) {
    // An older server: the stash stays on this phone.
    put({ status: "off", error: null });
    return;
  }
  const stash = useStashStore.getState();
  await stash.hydrate();
  if (!live() || !useStashStore.getState().hydrated) return;
  const deviceId = await homesDeviceId();
  if (!live()) return;
  put({ status: "syncing", error: null });

  // First sync with this server: files saved before sync get this
  // phone's id before they first go up. Only then: a record pulled from
  // the server is never claimed (its unnamed files are not this phone's).
  if (meta?.serverId !== serverId) {
    const here = useStashStore.getState().items.filter(isOwnSchema).map((i) => i.id);
    await useStashStore.getState().claimFiles(deviceId, here);
    if (!live()) return;
  }
  let m = metaFor(serverId);
  let fullNext = m.cursor === null;
  let registeredNow = false;

  // Push: each queued record as it is now.
  const byId = () => new Map(useStashStore.getState().items.map((i) => [i.id, i]));
  const items = byId();
  const waiting = m.outbox.flatMap((id) => {
    const i = items.get(id);
    return i && isOwnSchema(i) ? [i] : [];
  });
  if (waiting.length !== m.outbox.length) {
    // Gone here (an expired tombstone): nothing left to send.
    m = { ...m, outbox: waiting.map((i) => i.id) };
    saveMeta(m);
  }
  const queued = roomMaybe ? waiting : waiting.filter((i) => m.unsynced[i.id] !== "cap_reached");
  roomMaybe = false;
  for (const batch of stashPushBatches(queued)) {
    let r = await pushStash(scope, deviceId, batch);
    if (!live()) return;
    if (!r.ok && r.kind === "not_registered" && !registeredNow) {
      const reg = await registerHomesDevice(scope, { deviceId, ...homesDeviceInfo() });
      if (!live()) return;
      if (!reg.ok) {
        noteFailure(reg);
        return;
      }
      registeredNow = true;
      r = await pushStash(scope, deviceId, batch);
      if (!live()) return;
    }
    if (!r.ok) {
      noteFailure(r);
      return;
    }
    const refused = new Map(r.data.rejected.flatMap((x) => (x.id ? [[x.id, x.reason] as const] : [])));
    for (const [id, reason] of refused) console.warn("[stash-sync] server rejected", id, reason);
    const now = byId();
    const unsynced = { ...m.unsynced };
    const settled = new Set<string>();
    for (const sent of batch) {
      const reason = refused.get(sent.id);
      if (reason) unsynced[sent.id] = reason;
      else delete unsynced[sent.id];
      // A cap refusal waits here for room; anything else is settled,
      // unless it was edited again while this push was out.
      const cur = now.get(sent.id);
      if (reason !== "cap_reached" && (!cur || sameVersion(cur, sent))) settled.add(sent.id);
    }
    m = { ...meta!, outbox: meta!.outbox.filter((id) => !settled.has(id)), unsynced };
    saveMeta(m);
    if (r.data.superseded > 0) fullNext = true;
  }

  // Pull and merge.
  const pulled = await pullStash(scope, deviceId, fullNext ? null : m.cursor);
  if (!live()) return;
  if (!pulled.ok) {
    noteFailure(pulled);
    return;
  }
  const reply = pulled.data;
  const here = byId();
  const outbox = new Set(meta!.outbox);
  const unsynced = { ...meta!.unsynced };
  const winners: StashItem[] = [];
  for (const theirs of reply.changes) {
    const mine = here.get(theirs.id);
    if (mine && !stashWins(theirs, mine)) continue;
    winners.push(theirs);
    // The server's version won: ours has nothing left to send.
    outbox.delete(theirs.id);
    delete unsynced[theirs.id];
  }
  const drop: string[] = [];
  if (reply.full) {
    const held = new Set(reply.changes.map((i) => i.id));
    for (const i of here.values()) {
      if (isOwnSchema(i) && !held.has(i.id) && !outbox.has(i.id)) {
        drop.push(i.id);
        delete unsynced[i.id];
      }
    }
  }
  await useStashStore.getState().applySynced({ put: winners, drop });
  if (!live()) return;
  saveMeta({ ...meta!, cursor: reply.cursor ?? meta!.cursor, outbox: [...outbox], unsynced });
  retryAttempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  put({ status: "synced", error: null });
}

let running: Promise<void> | null = null;
let again = false;

/** Push the outbox, then pull. Single-flight; a call during a run makes
 *  one more run after it. Never throws. */
export function syncStashNow(): Promise<void> {
  if (!syncServer()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let guard = 0;
    do {
      again = false;
      try {
        await runOnce();
      } catch (e) {
        console.warn("[stash-sync] run failed", e);
        put({ status: "error", error: e instanceof Error ? e.message : String(e) });
        scheduleRetry();
        break;
      }
    } while (again && syncServer() && ++guard < 5);
  })().finally(() => {
    running = null;
  });
  return running;
}

// ─── Wiring ───

let started = false;
const stops: (() => void)[] = [];

/** Install the engine once (App). Idempotent; returns the remover. */
export function startStashSync(): () => void {
  if (started) return stopStashSync;
  started = true;

  const soon = () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void syncStashNow();
    }, PUSH_DEBOUNCE_MS);
  };

  // Local saves / deletes → outbox → push soon.
  stops.push(
    onStashLocalChange((ids) => {
      const serverId = syncServer();
      if (!serverId) return;
      const m = metaFor(serverId);
      saveMeta({ ...m, outbox: [...new Set([...m.outbox, ...ids])] });
      roomMaybe = true;
      soon();
    })
  );

  // `stash_changed` from the sync server, at another cursor.
  stops.push(
    onStashFrame((serverId, cursor) => {
      if (serverId !== syncServer()) return;
      if (cursor !== null && meta?.serverId === serverId && meta.cursor === cursor) return;
      soon();
    })
  );

  // The server is back / its socket reopened.
  stops.push(
    onServerSignal((id, signal) => {
      if (id !== syncServer()) return;
      if (signal === "recovered" || signal === "reopened" || signal === "lagged") void syncStashNow();
    })
  );

  // Foreground.
  if (typeof document !== "undefined") {
    const onVis = () => {
      if (document.visibilityState === "visible") void syncStashNow();
    };
    document.addEventListener("visibilitychange", onVis);
    stops.push(() => document.removeEventListener("visibilitychange", onVis));
  }

  // Home sync on, off or moved: follow it.
  stops.push(
    useHomesSyncStore.subscribe((s, p) => {
      if (s.serverId === p.serverId) return;
      gen += 1;
      clearTimers();
      retryAttempt = 0;
      if (s.serverId) void syncStashNow();
      else put({ status: "off", error: null });
    })
  );

  if (syncServer()) void syncStashNow();
  return stopStashSync;
}

export function stopStashSync(): void {
  for (const s of stops.splice(0)) s();
  clearTimers();
  gen += 1;
  started = false;
}

/** Tests only. */
export function __resetStashSyncForTests(): void {
  stopStashSync();
  running = null;
  again = false;
  retryAttempt = 0;
  roomMaybe = true;
  meta = readMeta();
  useStashSyncStore.setState({ status: "off", error: null, unsynced: meta?.unsynced ?? {} }, true);
}

/** Tests only. */
export function __stashSyncMeta(): Meta | null {
  return meta;
}
