import { create } from "zustand";
import { getBootStatus } from "../api/client";
import {
  FEATURE_HOMES_SYNC,
  listHomesDevices,
  onHomesFrame,
  pullHomes,
  pushHomes,
  registerHomesDevice,
  removeHomesDevice,
  type SyncDevice,
  type SyncFailure,
} from "../api/homesSync";
import { scopeFor } from "../api/scope";
import { onServerSignal } from "../api/serverSignals";
import { getDeviceId } from "../lib/push";
import { hostLabel, onServerForget, useServersStore } from "../stores/servers";
import { useHomeServerIds } from "./homeServerIds";
import { onHomesLocalChange, setHomesWriterId, useHomesStore } from "./homes";
import {
  applyRemote,
  changeKey,
  coalesceOutbox,
  firstSyncMerge,
  settleOutbox,
  type ChangeItem,
} from "./homesMerge";
import { subscribeAppEvents, type TicketEventsHandle } from "./ticketEvents";

// Homes sync engine (K2 0.46.1 `homes-sync-v1`).
//
// LOCAL-FIRST: `useHomesStore` is always the working copy and Home always
// renders from it. Nothing here blocks, spins or empties Home: a server
// that is down only means the outbox waits.
//
// The person picks ONE saved server to sync through (Server settings →
// "Sync my Home with this server"). That pick is this phone's
// (`k2.homes.syncServer.v1` = the saved server's id). Nothing goes to K2
// Web.
//
// Flow:
//   - every local edit (homes.ts `commit`) hands its stamped changes here;
//     they join the outbox (`k2.homes.outbox.v1`, one item per key, the
//     latest write wins) and are pushed shortly after;
//   - a sync run = push the outbox (if any), then pull since the cursor
//     and merge last-writer-wins (`./homesMerge`). Rejected items leave
//     the outbox (logged) and the pull converges;
//   - runs on: a local edit, a `homes_changed` frame, the app coming to
//     the foreground, the server coming back (`recovered` / `reopened` /
//     `lagged`), and a backoff retry (2 s doubling to 60 s) after a
//     failure;
//   - 410 `device_removed`, a `homes_device_removed` frame for this phone,
//     or `device.syncing:false` on a pull: syncing stops, the Homes stay,
//     and a one-time notice says so. Re-sync = turn the switch on again.
//
// Gate: the sync server's `/boot-status` must list `homes-sync-v1`. An
// unreachable server is "offline", not "unsupported".

export const HOMES_SYNC_SERVER_KEY = "k2.homes.syncServer.v1";
export const HOMES_SYNC_META_KEY = "k2.homes.syncMeta.v1";
export const HOMES_OUTBOX_KEY = "k2.homes.outbox.v1";
export const HOMES_SYNC_NOTICE_KEY = "k2.homes.syncNotice.v1";
export const HOMES_DEVICE_ID_KEY = "k2.homes.deviceId.v1";

export const PUSH_DEBOUNCE_MS = 400;
export const FRAME_DEBOUNCE_MS = 300;
export const RETRY_BASE_MS = 2_000;
export const RETRY_CAP_MS = 60_000;

export type HomesSyncStatus = "off" | "syncing" | "synced" | "offline" | "error";

export interface HomesSyncNotice {
  serverId: string;
  label: string;
}

// ─── Storage (never throws) ───

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* lasts this session */
  }
}

function readJson(key: string): Record<string, unknown> | null {
  const raw = lsGet(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readSyncServer(): string | null {
  const v = lsGet(HOMES_SYNC_SERVER_KEY);
  return v && v.trim() ? v.trim() : null;
}

/** `{serverId, cursor, lastSyncAt}` — the cursor belongs to one server. */
function readMeta(serverId: string | null): { cursor: string | null; lastSyncAt: number | null } {
  const j = readJson(HOMES_SYNC_META_KEY);
  if (!j || !serverId || j.serverId !== serverId) return { cursor: null, lastSyncAt: null };
  return {
    cursor: typeof j.cursor === "string" ? j.cursor : null,
    lastSyncAt: typeof j.lastSyncAt === "number" ? j.lastSyncAt : null,
  };
}

function writeMeta(serverId: string | null, cursor: string | null, lastSyncAt: number | null): void {
  lsSet(HOMES_SYNC_META_KEY, serverId ? JSON.stringify({ serverId, cursor, lastSyncAt }) : null);
}

function isChange(v: unknown): v is ChangeItem {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.updatedAt !== "number" || typeof c.order !== "string") return false;
  if (c.kind === "home") return typeof c.id === "string" && typeof c.name === "string";
  return c.kind === "row" && typeof c.homeId === "string" && typeof c.address === "string";
}

/** The persisted outbox for `serverId` (another server's is dropped). */
export function readOutbox(serverId: string | null): ChangeItem[] {
  const j = readJson(HOMES_OUTBOX_KEY);
  if (!j || !serverId || j.serverId !== serverId || !Array.isArray(j.items)) return [];
  return j.items.filter(isChange);
}

function writeOutbox(serverId: string | null, items: ChangeItem[]): void {
  lsSet(HOMES_OUTBOX_KEY, serverId && items.length > 0 ? JSON.stringify({ serverId, items }) : null);
}

function readNotice(): HomesSyncNotice | null {
  const j = readJson(HOMES_SYNC_NOTICE_KEY);
  return j && typeof j.serverId === "string" && typeof j.label === "string"
    ? { serverId: j.serverId, label: j.label }
    : null;
}

// ─── Device identity ───

let deviceIdPromise: Promise<string> | null = null;
let deviceIdSource: () => Promise<string> = defaultDeviceId;

function localDeviceId(): string {
  const have = lsGet(HOMES_DEVICE_ID_KEY);
  if (have) return have;
  const id = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  lsSet(HOMES_DEVICE_ID_KEY, id);
  return id;
}

/** The push deviceId (plugin-store, stable per install); without the
 *  plugin (plain-browser dev) a stable id of our own in localStorage. */
async function defaultDeviceId(): Promise<string> {
  try {
    const id = await Promise.race([
      getDeviceId(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    if (typeof id === "string" && id) return id;
  } catch {
    /* fall through */
  }
  return localDeviceId();
}

/** This phone's Homes-sync device id (cached). */
export function homesDeviceId(): Promise<string> {
  deviceIdPromise ??= deviceIdSource().then((id) => {
    setHomesWriterId(id);
    return id;
  });
  return deviceIdPromise;
}

/** "iPhone" / "iPad" / "Android" + platform for devices/register. */
export function homesDeviceInfo(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): {
  name: string;
  platform: string;
} {
  if (/iPad/i.test(ua)) return { name: "iPad", platform: "ios" };
  if (/iPhone|iPod/i.test(ua)) return { name: "iPhone", platform: "ios" };
  if (/Android/i.test(ua)) return { name: "Android phone", platform: "android" };
  return { name: "Phone", platform: "web" };
}

// ─── Store ───

interface HomesSyncState {
  /** The saved server Homes sync through, or null. */
  serverId: string | null;
  status: HomesSyncStatus;
  error: string | null;
  lastSyncAt: number | null;
  /** Queued changes not yet on the server. */
  outbox: ChangeItem[];
  /** Saved server id → has `homes-sync-v1`. Absent = not probed. */
  feature: Record<string, boolean>;
  /** Saved server id → its device list (last read). */
  devices: Record<string, SyncDevice[] | undefined>;
  devicesError: Record<string, string | null>;
  /** "This phone was removed from Home sync on {server}." (one-time). */
  notice: HomesSyncNotice | null;
  /** An enable / disable in progress (the switch waits). */
  busy: boolean;
}

function initialState(): HomesSyncState {
  const serverId = readSyncServer();
  const meta = readMeta(serverId);
  return {
    serverId,
    status: serverId ? "synced" : "off",
    error: null,
    lastSyncAt: meta.lastSyncAt,
    outbox: readOutbox(serverId),
    feature: {},
    devices: {},
    devicesError: {},
    notice: readNotice(),
    busy: false,
  };
}

export const useHomesSyncStore = create<HomesSyncState>(() => initialState());

const st = () => useHomesSyncStore.getState();
const put = (p: Partial<HomesSyncState>) => useHomesSyncStore.setState(p);

let cursor: string | null = readMeta(readSyncServer()).cursor;
/** Bumped by every enable / disable / removal: a run from before stops. */
let gen = 0;

function labelOf(serverId: string): string {
  const e = useServersStore.getState().servers.find((s) => s.id === serverId);
  return e ? e.nickname || hostLabel(e.url) : "this server";
}

function setOutbox(items: ChangeItem[]): void {
  put({ outbox: items });
  writeOutbox(st().serverId, items);
}

function setCursor(next: string | null, lastSyncAt = st().lastSyncAt): void {
  cursor = next;
  writeMeta(st().serverId, cursor, lastSyncAt);
}

// ─── Retry ───

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let frameTimer: ReturnType<typeof setTimeout> | null = null;

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
}

function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (pushTimer) clearTimeout(pushTimer);
  if (frameTimer) clearTimeout(frameTimer);
  retryTimer = pushTimer = frameTimer = null;
}

function scheduleRetry(): void {
  if (retryTimer || !st().serverId) return;
  const delay = retryDelayMs(retryAttempt++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncHomesNow();
  }, delay);
}

// ─── Socket (keeps the person's app-event socket open while syncing) ───

let hub: { serverId: string; handle: TicketEventsHandle } | null = null;

function connectHub(): void {
  const sid = st().serverId;
  if (hub && hub.serverId === sid) return;
  hub?.handle.stop();
  hub = null;
  if (!sid) return;
  // Homes frames reach `onHomesFrame` from the hub itself
  // (ticketEvents → emitHomesFrame); this subscription only holds the
  // socket open.
  hub = { serverId: sid, handle: subscribeAppEvents(scopeFor(sid), () => false, () => {}) };
}

function disconnectHub(): void {
  hub?.handle.stop();
  hub = null;
}

// ─── Stop syncing ───

function stopLocally(status: HomesSyncStatus = "off"): void {
  gen += 1;
  clearTimers();
  disconnectHub();
  writeOutbox(null, []);
  writeMeta(null, null, null);
  lsSet(HOMES_SYNC_SERVER_KEY, null);
  cursor = null;
  retryAttempt = 0;
  put({ serverId: null, status, error: null, outbox: [], lastSyncAt: null });
}

/** 410 / removed frame / `syncing:false`: stop, keep Homes, say so once. */
function handleRemoved(serverId: string): void {
  if (st().serverId !== serverId) return;
  const notice = { serverId, label: labelOf(serverId) };
  stopLocally();
  lsSet(HOMES_SYNC_NOTICE_KEY, JSON.stringify(notice));
  put({ notice, devices: { ...st().devices, [serverId]: undefined } });
}

export function dismissHomesSyncNotice(): void {
  lsSet(HOMES_SYNC_NOTICE_KEY, null);
  put({ notice: null });
}

/** A failed call: the status it leaves, and whether to retry. */
function noteFailure(serverId: string, f: SyncFailure): void {
  if (f.kind === "removed") {
    handleRemoved(serverId);
    return;
  }
  if (f.kind === "offline") put({ status: "offline", error: null });
  else if (f.kind === "auth") put({ status: "error", error: `Sign in to ${labelOf(serverId)} to sync` });
  else put({ status: "error", error: f.error });
  scheduleRetry();
}

// ─── One run: push, then pull ───

let running: Promise<void> | null = null;
let again = false;

async function runOnce(): Promise<void> {
  const serverId = st().serverId;
  if (!serverId) return;
  const myGen = gen;
  const live = () => gen === myGen && st().serverId === serverId;
  const scope = scopeFor(serverId);
  let token = "";
  try {
    token = scope.token();
  } catch {
    return; // removed: onServerForget turns sync off
  }
  if (!token) {
    put({ status: "error", error: `Sign in to ${labelOf(serverId)} to sync` });
    return;
  }
  const boot = await getBootStatus(scope);
  if (!live()) return;
  if (!boot) {
    put({ status: "offline", error: null });
    scheduleRetry();
    return;
  }
  const on = boot.features.includes(FEATURE_HOMES_SYNC);
  put({ feature: { ...st().feature, [serverId]: on } });
  if (!on) {
    put({ status: "error", error: `${labelOf(serverId)} does not offer Home sync` });
    return;
  }
  const deviceId = await homesDeviceId();
  if (!live()) return;
  put({ status: "syncing", error: null });

  const sent = st().outbox;
  if (sent.length > 0) {
    const r = await pushHomes(scope, deviceId, sent);
    if (!live()) return;
    if (!r.ok) {
      noteFailure(serverId, r);
      return;
    }
    const rejectedKeys: string[] = [];
    for (const rj of r.data.rejected) {
      if (rj.item) rejectedKeys.push(changeKey(rj.item));
      console.warn("[homes-sync] server rejected", rj.item, rj.reason);
    }
    setOutbox(settleOutbox(st().outbox, sent, rejectedKeys));
    if (r.data.changes.length > 0) mergeIn(r.data.changes);
  }

  const pulled = await pullHomes(scope, deviceId, cursor);
  if (!live()) return;
  if (!pulled.ok) {
    noteFailure(serverId, pulled);
    return;
  }
  if (pulled.data.syncing === false) {
    handleRemoved(serverId);
    return;
  }
  const orphans = mergeIn(pulled.data.changes);
  const now = Date.now();
  if (orphans > 0 && cursor !== null) {
    // Rows for a Home we never saw: re-pull the full set.
    setCursor(null, now);
    again = true;
  } else {
    setCursor(pulled.data.cursor ?? cursor, now);
  }
  retryAttempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  put({ status: "synced", error: null, lastSyncAt: now });
  writeMeta(serverId, cursor, now);
  if (st().outbox.length > 0) again = true;
}

/** Merge pulled changes into the local Homes. Returns the orphan count. */
function mergeIn(changes: ChangeItem[]): number {
  if (changes.length === 0) return 0;
  const homes = useHomesStore.getState();
  const res = applyRemote(homes.syncState(), changes);
  if (res.changed) homes.applySynced(res.state);
  return res.orphans;
}

/** Push the outbox, then pull. Single-flight; a call during a run makes
 *  one more run after it. Never throws. */
export function syncHomesNow(): Promise<void> {
  if (!st().serverId) return Promise.resolve();
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
        console.warn("[homes-sync] run failed", e);
        put({ status: "error", error: e instanceof Error ? e.message : String(e) });
        scheduleRetry();
        break;
      }
    } while (again && st().serverId && ++guard < 5);
  })().finally(() => {
    running = null;
  });
  return running;
}

// ─── Enable / disable ───

/** Probe `homes-sync-v1` on a saved server (cached boot-status). */
export async function probeHomesSync(serverId: string): Promise<boolean> {
  let on = false;
  try {
    const b = await getBootStatus(scopeFor(serverId));
    on = !!b && b.features.includes(FEATURE_HOMES_SYNC);
  } catch {
    on = false;
  }
  if (st().feature[serverId] !== on) put({ feature: { ...st().feature, [serverId]: on } });
  return on;
}

/**
 * Sync this phone's Homes through `serverId`: register this device, pull
 * the server's full set, merge (union, never delete), then push the
 * union. Moving from another server removes this device there
 * (best-effort) once the new one took it. False (with `error`) when it
 * could not start; the Homes are untouched then.
 */
export async function enableHomesSync(serverId: string): Promise<boolean> {
  const prev = st().serverId;
  const scope = scopeFor(serverId);
  put({ busy: true, error: null });
  try {
    let token = "";
    try {
      token = scope.token();
    } catch {
      token = "";
    }
    if (!token) {
      put({ error: `Sign in to ${labelOf(serverId)} first` });
      return false;
    }
    // Fresh /boot-status: the gate, and the box id (rows migrate to it
    // before the first merge, so the server never sees the old spelling).
    const boot = await getBootStatus(scope, { fresh: true });
    if (!boot) {
      put({ error: `Could not reach ${labelOf(serverId)}` });
      return false;
    }
    if (!boot.features.includes(FEATURE_HOMES_SYNC)) {
      put({ feature: { ...st().feature, [serverId]: false }, error: `${labelOf(serverId)} does not offer Home sync` });
      return false;
    }
    migrateRows();
    const deviceId = await homesDeviceId();
    const reg = await registerHomesDevice(scope, { deviceId, ...homesDeviceInfo() });
    if (!reg.ok) {
      put({ error: reg.kind === "offline" ? `Could not reach ${labelOf(serverId)}` : reg.error });
      return false;
    }
    const full = await pullHomes(scope, deviceId, null);
    if (!full.ok) {
      put({ error: full.kind === "offline" ? `Could not reach ${labelOf(serverId)}` : full.error });
      return false;
    }
    // The switch: stop the old server's runs, then merge locally.
    gen += 1;
    clearTimers();
    const homes = useHomesStore.getState();
    const merged = firstSyncMerge(homes.syncState(), full.data.changes, { now: Date.now(), by: deviceId });
    homes.applySynced(merged.state);
    lsSet(HOMES_SYNC_SERVER_KEY, serverId);
    lsSet(HOMES_SYNC_NOTICE_KEY, null);
    retryAttempt = 0;
    put({ serverId, status: "syncing", notice: null, outbox: [] });
    setCursor(full.data.cursor, null);
    setOutbox(coalesceOutbox([], merged.changes));
    connectHub();
    if (prev && prev !== serverId) {
      void removeHomesDevice(scopeFor(prev), deviceId).catch(() => undefined);
      put({ devices: { ...st().devices, [prev]: undefined } });
    }
    await syncHomesNow();
    void loadHomesDevices(serverId);
    return true;
  } finally {
    put({ busy: false });
  }
}

/** Stop syncing: remove this device on the server (best-effort), keep
 *  the local Homes exactly as they are. */
export async function disableHomesSync(): Promise<void> {
  const serverId = st().serverId;
  if (!serverId) return;
  put({ busy: true });
  try {
    stopLocally();
    const deviceId = await homesDeviceId();
    const r = await removeHomesDevice(scopeFor(serverId), deviceId).catch(() => null);
    if (r && !r.ok && r.kind !== "removed") console.warn("[homes-sync] device remove failed:", r.error);
    put({ devices: { ...st().devices, [serverId]: undefined } });
  } finally {
    put({ busy: false });
  }
}

// ─── Devices ───

export async function loadHomesDevices(serverId: string): Promise<void> {
  const deviceId = await homesDeviceId();
  const r = await listHomesDevices(scopeFor(serverId));
  if (!r.ok) {
    if (r.kind === "removed") handleRemoved(serverId);
    put({ devicesError: { ...st().devicesError, [serverId]: r.error } });
    return;
  }
  const list = r.data.map((d) => (d.deviceId === deviceId ? { ...d, current: true } : d));
  put({
    devices: { ...st().devices, [serverId]: list },
    devicesError: { ...st().devicesError, [serverId]: null },
  });
}

/** Remove a device from Home sync on `serverId`. This phone = turn off. */
export async function removeHomesSyncDevice(serverId: string, deviceId: string): Promise<boolean> {
  const mine = await homesDeviceId();
  if (deviceId === mine && st().serverId === serverId) {
    await disableHomesSync();
    return true;
  }
  const r = await removeHomesDevice(scopeFor(serverId), deviceId);
  if (!r.ok && r.kind !== "removed") {
    put({ devicesError: { ...st().devicesError, [serverId]: r.error } });
    return false;
  }
  const list = st().devices[serverId];
  if (list) put({ devices: { ...st().devices, [serverId]: list.filter((d) => d.deviceId !== deviceId) } });
  void loadHomesDevices(serverId);
  return true;
}

// ─── Wiring ───

let started = false;
const stops: (() => void)[] = [];

function migrateRows(): void {
  if (!useServersStore.getState().hydrated) return;
  useHomesStore.getState().migrateAddresses();
}

/** Install the engine once (App). Idempotent; returns the remover. */
export function startHomesSync(): () => void {
  if (started) return stopHomesSync;
  started = true;
  void homesDeviceId();

  // Local edits → outbox → push soon.
  stops.push(
    onHomesLocalChange((changes) => {
      if (!st().serverId) return;
      setOutbox(coalesceOutbox(st().outbox, changes));
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = null;
        void syncHomesNow();
      }, PUSH_DEBOUNCE_MS);
    })
  );

  // Frames from the sync server.
  stops.push(
    onHomesFrame((serverId, frame) => {
      if (serverId !== st().serverId) return;
      if (frame.type === "changed") {
        if (frameTimer) clearTimeout(frameTimer);
        frameTimer = setTimeout(() => {
          frameTimer = null;
          void syncHomesNow();
        }, FRAME_DEBOUNCE_MS);
        return;
      }
      void homesDeviceId().then((mine) => {
        if (!frame.deviceId || frame.deviceId === mine) handleRemoved(serverId);
        else if (st().devices[serverId]) void loadHomesDevices(serverId);
      });
    })
  );

  // The server is back / its socket reopened: catch up.
  stops.push(
    onServerSignal((id, signal) => {
      if (id !== st().serverId) return;
      if (signal === "recovered" || signal === "reopened" || signal === "lagged") void syncHomesNow();
    })
  );

  // Foreground: catch up.
  if (typeof document !== "undefined") {
    const onVis = () => {
      if (document.visibilityState === "visible") void syncHomesNow();
    };
    document.addEventListener("visibilitychange", onVis);
    stops.push(() => document.removeEventListener("visibilitychange", onVis));
  }

  // The sync server removed from this phone: stop (no network; no token).
  stops.push(
    onServerForget((id, reason) => {
      if (id === st().serverId && reason === "removed") stopLocally();
    })
  );

  // hostKey → box id: migrate rows whenever a new box id is learnt.
  stops.push(useHomeServerIds.subscribe((s, p) => (s.bySaved !== p.bySaved ? migrateRows() : undefined)));
  stops.push(
    useServersStore.subscribe((s, p) => {
      if (s.servers !== p.servers || s.hydrated !== p.hydrated) migrateRows();
      // A fresh sign-in on the sync server: try again now.
      const sid = st().serverId;
      if (sid && s.tokens[sid] && s.tokens[sid] !== p.tokens[sid]) void syncHomesNow();
    })
  );
  migrateRows();

  if (st().serverId) {
    connectHub();
    void syncHomesNow();
  }
  return stopHomesSync;
}

export function stopHomesSync(): void {
  for (const s of stops.splice(0)) s();
  clearTimers();
  disconnectHub();
  started = false;
}

// ─── Views ───

/** The Server settings status line. */
export function homesSyncStatusText(
  s: Pick<HomesSyncState, "serverId" | "status" | "error" | "lastSyncAt">,
  now = Date.now()
): string {
  if (!s.serverId || s.status === "off") return "Not synced";
  if (s.status === "syncing") return "Syncing…";
  if (s.status === "offline") return "Offline — changes will sync later";
  if (s.status === "error") return s.error || "Could not sync";
  return `Synced · ${agoText(s.lastSyncAt, now)}`;
}

export function agoText(at: number | null, now = Date.now()): string {
  if (!at) return "just now";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

/** The Home tab's badge: which server Home syncs from, or null. */
export function useHomesSyncBadge(): { serverId: string; label: string; initial: string } | null {
  const serverId = useHomesSyncStore((s) => s.serverId);
  const label = useServersStore((s) => {
    const e = serverId ? s.servers.find((x) => x.id === serverId) : null;
    return e ? e.nickname || hostLabel(e.url) : "";
  });
  if (!serverId || !label) return null;
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  return { serverId, label, initial };
}

/** Tests only. */
export function __resetHomesSyncForTests(opts: { deviceId?: string } = {}): void {
  stopHomesSync();
  gen += 1;
  running = null;
  again = false;
  retryAttempt = 0;
  deviceIdPromise = null;
  deviceIdSource = opts.deviceId ? async () => opts.deviceId as string : defaultDeviceId;
  cursor = readMeta(readSyncServer()).cursor;
  useHomesSyncStore.setState(initialState(), true);
}

/** Tests only: the in-memory pull cursor. */
export function __homesSyncCursor(): string | null {
  return cursor;
}
