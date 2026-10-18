// Homes sync wire adapter (K2 0.46.1 `homes-sync-v1`). The ONLY module
// that knows the wire's spelling: everything else speaks the merge model
// (`zen/homesMerge`). If K2 renames a field, change it here.
//
// The final 0.46.1 contract (K2 feat/homes-sync e22e3b774). Routes, all on
// the ONE server the person picked, Bearer token via `scopedFetch`, writes
// are POST:
//   GET  /cli/me/homes?deviceId=<id>&since=<cursor>
//        → {ok, person, serverId, cursor:<int>, full, changes:[item…],
//           redirects:{oldId:newId}, device:{deviceId, syncing},
//           servers:{hostKey:serverId}}
//        No `since`, or a `since` below the tombstone floor / ahead of the
//        server, answers `full:true` with the whole live set. Works for an
//        unregistered device (`device.syncing:false`).
//   POST /cli/me/homes/push {deviceId, changes:[…]}
//        → {ok, cursor, applied:<count>, superseded:<count>,
//           rejected:[{item, reason}]}
//        409 `device_not_registered` until the device registered.
//   POST /cli/me/homes/devices/register {deviceId, name, platform}
//   GET  /cli/me/homes/devices → {ok, devices:[{deviceId, name, platform,
//        registeredAt, lastSyncAt, current}]} (a bare array also read)
//   POST /cli/me/homes/devices/remove {deviceId} → {ok, removed, deviceId}
// A removed device gets 410 `device_removed` from pull / push.
// Items carry `deviceId` (the writer: the LWW tie-break, `by` here); a
// Home tombstone may carry `mergedInto`.
//
// Frames on the person's `/cli/sessions/events` sockets:
// `{kind:"homes_changed", cursor}` and `{kind:"homes_device_removed",
// deviceId}`.

import type { ServerScope } from "./scope";
import { scopedFetch, NOT_CONNECTED } from "./scopedFetch";
import { apiErrorText } from "../lib/apiError";
import type { ChangeItem } from "../zen/homesMerge";

export const FEATURE_HOMES_SYNC = "homes-sync-v1";

// ─── Results ───

export type SyncFailure =
  /** 410 `device_removed`: stop syncing on this phone. */
  | { ok: false; kind: "removed"; error: string }
  /** 409 `device_not_registered`: register, then try again. */
  | { ok: false; kind: "not_registered"; error: string; status: number }
  /** Network error / timeout / no server: retry later. */
  | { ok: false; kind: "offline"; error: string }
  /** Signed out of that server (401 after revive). */
  | { ok: false; kind: "auth"; error: string; status: number }
  /** Any other HTTP error. */
  | { ok: false; kind: "http"; error: string; status: number };

export type SyncResult<T> = { ok: true; data: T } | SyncFailure;

// ─── Wire → model ───

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

/** One wire change item → the model's. Null when unreadable. */
export function parseChangeItem(raw: unknown): ChangeItem | null {
  const o = obj(raw);
  if (!o) return null;
  const kind = str(pick(o, "kind", "type"));
  const updatedAt = num(pick(o, "updatedAt", "updated_at")) ?? 0;
  const deleted = pick(o, "deleted") === true || pick(o, "deletedAt", "deleted_at") != null;
  const by = str(pick(o, "deviceId", "device_id", "by"));
  const order = pick(o, "order");
  const orderStr = typeof order === "string" ? order : "";
  if (kind === "home") {
    const id = str(pick(o, "id", "homeId", "home_id"));
    if (!id) return null;
    const c: ChangeItem = { kind: "home", id, name: str(o.name) ?? "", order: orderStr, updatedAt };
    if (by) c.by = by;
    if (deleted) c.deleted = true;
    const into = str(pick(o, "mergedInto", "merged_into"));
    if (deleted && into) c.mergedInto = into;
    return c;
  }
  if (kind === "row") {
    const homeId = str(pick(o, "homeId", "home_id"));
    const address = str(o.address);
    if (!homeId || !address) return null;
    const ws = pick(o, "workspaceId", "workspace_id");
    const c: ChangeItem = {
      kind: "row",
      homeId,
      address: address.trim().toLowerCase(),
      label: str(o.label) ?? "",
      workspaceId: typeof ws === "string" ? ws : null,
      order: orderStr,
      updatedAt,
    };
    if (by) c.by = by;
    if (deleted) c.deleted = true;
    return c;
  }
  return null;
}

/** Model → wire. `by` is not sent: the push names its device. */
export function toWireChange(c: ChangeItem): Record<string, unknown> {
  if (c.kind === "home") {
    const w: Record<string, unknown> = { kind: "home", id: c.id, name: c.name, order: c.order, updatedAt: c.updatedAt };
    if (c.deleted) w.deleted = true;
    if (c.deleted && c.mergedInto) w.mergedInto = c.mergedInto;
    return w;
  }
  const w: Record<string, unknown> = {
    kind: "row",
    homeId: c.homeId,
    address: c.address,
    label: c.label,
    workspaceId: c.workspaceId,
    order: c.order,
    updatedAt: c.updatedAt,
  };
  if (c.deleted) w.deleted = true;
  return w;
}

/** An integer cursor (a numeric string is read too); null otherwise. */
export function parseCursor(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function strRecord(v: unknown): Record<string, string> {
  const o = obj(v);
  const out: Record<string, string> = {};
  if (!o) return out;
  for (const [k, val] of Object.entries(o)) if (k && typeof val === "string" && val) out[k] = val;
  return out;
}

export interface PullReply {
  changes: ChangeItem[];
  cursor: number | null;
  /** The whole live set (no / stale / ahead `since`), not a delta. */
  full: boolean;
  /** Old Home id → the Home it merged into. */
  redirects: Record<string, string>;
  /** hostKey → serverId the server vouches for (its tunnel host, pinned
   *  peers). */
  servers: Record<string, string>;
  person: string | null;
  serverId: string | null;
  /** `device.syncing`; null when absent. `false` = not registered (yet). */
  syncing: boolean | null;
}

export function parsePullReply(raw: unknown): PullReply {
  const o = obj(raw) ?? {};
  const list = Array.isArray(o.changes) ? o.changes : Array.isArray(o.homes) ? o.homes : [];
  const device = obj(o.device);
  return {
    changes: list.map(parseChangeItem).filter((c): c is ChangeItem => c !== null),
    cursor: parseCursor(o.cursor),
    full: o.full === true,
    redirects: strRecord(o.redirects),
    servers: strRecord(o.servers),
    person: str(o.person),
    serverId: str(o.serverId),
    syncing: device && typeof device.syncing === "boolean" ? device.syncing : null,
  };
}

export interface PushReply {
  cursor: number | null;
  applied: number | null;
  /** Items the server already held a newer version of (not errors): they
   *  leave the outbox and a pull brings the newer version. */
  superseded: number;
  /** Rejected items (as the model reads them) and why. */
  rejected: { item: ChangeItem | null; reason: string }[];
  /** Changes the server sent back with the reply, if any. */
  changes: ChangeItem[];
}

function count(v: unknown): number | null {
  return Array.isArray(v) ? v.length : num(v);
}

export function parsePushReply(raw: unknown): PushReply {
  const o = obj(raw) ?? {};
  const rejected = Array.isArray(o.rejected)
    ? o.rejected.map((r) => {
        const ro = obj(r) ?? {};
        return { item: parseChangeItem(ro.item ?? r), reason: str(ro.reason) ?? "rejected" };
      })
    : [];
  const list = Array.isArray(o.changes) ? o.changes : Array.isArray(o.homes) ? o.homes : [];
  return {
    cursor: parseCursor(o.cursor),
    applied: count(o.applied),
    superseded: count(o.superseded) ?? 0,
    rejected,
    changes: list.map(parseChangeItem).filter((c): c is ChangeItem => c !== null),
  };
}

export interface SyncDevice {
  deviceId: string;
  name: string;
  platform: string;
  /** Epoch ms, or null when never. */
  lastSyncAt: number | null;
  current: boolean;
}

function parseTime(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n < 1e12 ? n * 1000 : n; // seconds → ms
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function parseDevices(raw: unknown): SyncDevice[] {
  const o = obj(raw);
  const list = Array.isArray(raw) ? raw : o && Array.isArray(o.devices) ? o.devices : [];
  const out: SyncDevice[] = [];
  for (const d of list) {
    const r = obj(d);
    const id = r ? str(pick(r, "deviceId", "device_id", "id")) : null;
    if (!r || !id) continue;
    out.push({
      deviceId: id,
      name: str(r.name) || "Device",
      platform: str(r.platform) ?? "",
      lastSyncAt: parseTime(pick(r, "lastSyncAt", "last_sync_at")),
      current: r.current === true,
    });
  }
  return out;
}

// ─── Frames ───

export type HomesFrame =
  /** `cursor`: the server's cursor after the change (null when absent). */
  | { type: "changed"; cursor: number | null }
  | { type: "device_removed"; deviceId: string | null };

/** `{kind:"homes_changed", cursor}` / `{kind:"homes_device_removed",
 *  deviceId}` (the name is also read from `type`, `t` or `event`; fields
 *  from `data` / `payload`). Null for any other frame. */
export function parseHomesFrame(frame: unknown): HomesFrame | null {
  const o = obj(frame);
  if (!o) return null;
  const name = str(pick(o, "kind", "type", "t", "event"));
  if (name === "homes_changed") {
    const data = obj(o.data) ?? obj(o.payload) ?? {};
    return { type: "changed", cursor: parseCursor(o.cursor ?? data.cursor) };
  }
  if (name === "homes_device_removed") {
    const data = obj(o.data) ?? obj(o.payload) ?? {};
    const id = str(pick(o, "deviceId", "device_id")) ?? str(pick(data, "deviceId", "device_id"));
    return { type: "device_removed", deviceId: id };
  }
  return null;
}

export function isHomesFrame(frame: unknown): boolean {
  return parseHomesFrame(frame) !== null;
}

type FrameListener = (serverId: string, frame: HomesFrame) => void;
const frameListeners = new Set<FrameListener>();

/** Sockets call this for every frame; Homes frames reach the sync engine.
 *  True when the frame was a Homes frame. */
export function emitHomesFrame(serverId: string, frame: unknown): boolean {
  const parsed = parseHomesFrame(frame);
  if (!parsed || !serverId) return false;
  for (const fn of [...frameListeners]) {
    try {
      fn(serverId, parsed);
    } catch {
      /* never breaks a socket */
    }
  }
  return true;
}

export function onHomesFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => {
    frameListeners.delete(fn);
  };
}

// ─── Calls ───

async function call<T>(
  scope: ServerScope,
  path: string,
  parse: (raw: unknown) => T,
  opts: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {}
): Promise<SyncResult<T>> {
  let out;
  try {
    out = await scopedFetch(scope, path, {
      method: opts.method ?? "GET",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      query: opts.query,
      timeoutMs: 15_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, kind: "offline", error: msg === NOT_CONNECTED ? NOT_CONNECTED : msg };
  }
  if (out.status === 410) return { ok: false, kind: "removed", error: apiErrorText(out.text, "device_removed") };
  if (out.status === 409 && /device_not_registered/.test(out.text)) {
    return { ok: false, kind: "not_registered", status: 409, error: apiErrorText(out.text, "device_not_registered") };
  }
  if (out.status === 401) {
    return { ok: false, kind: "auth", status: out.status, error: apiErrorText(out.text, "Sign in again") };
  }
  if (!out.ok) {
    // A gateway / tunnel failure reads as offline: retry later.
    if (out.status === 502 || out.status === 503 || out.status === 504) {
      return { ok: false, kind: "offline", error: `HTTP ${out.status}` };
    }
    return { ok: false, kind: "http", status: out.status, error: apiErrorText(out.text, `HTTP ${out.status}`) };
  }
  let raw: unknown = null;
  try {
    raw = out.text.trim() ? JSON.parse(out.text) : null;
  } catch {
    raw = null;
  }
  return { ok: true, data: parse(raw) };
}

export function pullHomes(scope: ServerScope, deviceId: string, since: number | null): Promise<SyncResult<PullReply>> {
  const query: Record<string, string> = { deviceId };
  if (since !== null && Number.isInteger(since) && since >= 0) query.since = String(since);
  return call(scope, "/cli/me/homes", parsePullReply, { query });
}

export function pushHomes(scope: ServerScope, deviceId: string, changes: ChangeItem[]): Promise<SyncResult<PushReply>> {
  return call(scope, "/cli/me/homes/push", parsePushReply, {
    method: "POST",
    body: { deviceId, changes: changes.map(toWireChange) },
  });
}

export function registerHomesDevice(
  scope: ServerScope,
  device: { deviceId: string; name: string; platform: string }
): Promise<SyncResult<unknown>> {
  return call(scope, "/cli/me/homes/devices/register", (r) => r, { method: "POST", body: device });
}

export function listHomesDevices(scope: ServerScope): Promise<SyncResult<SyncDevice[]>> {
  return call(scope, "/cli/me/homes/devices", parseDevices);
}

export function removeHomesDevice(scope: ServerScope, deviceId: string): Promise<SyncResult<unknown>> {
  return call(scope, "/cli/me/homes/devices/remove", (r) => r, { method: "POST", body: { deviceId } });
}
