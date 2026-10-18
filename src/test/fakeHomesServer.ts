// A tiny in-memory K2 0.46.1 Homes-sync server for tests, in the FINAL
// contract's shapes (K2 feat/homes-sync e22e3b774): boot-status
// (`serverId`, `publicHost`), `/cli/me/homes` (integer cursor, `full`,
// `redirects`, `servers`, `person`, `device.syncing`), push (409 until
// registered; last writer wins per key on updatedAt → larger deviceId →
// tombstone; `applied` / `superseded` counts; live items before
// tombstones), devices register / list (`{ok, devices}`) / remove, and
// 410 for a removed device. Hand `fetch` to the mocked
// `@tauri-apps/plugin-http`.

import { isValidOrder } from "../zen/fracIndex";

type Item = Record<string, unknown>;

export interface FakeDevice {
  deviceId: string;
  name: string;
  platform: string;
  registeredAt?: number;
  lastSyncAt: number | null;
}

export interface FakeHomesServer {
  host: string;
  /** Answer like `tauriFetch(url, init)`. Throws "offline" when down. */
  fetch: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{
    status: number;
    ok: boolean;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
  /** Wire items held now (latest per key). */
  items: () => Item[];
  /** Seed items as another device would have pushed them (no checks). */
  seed: (items: Item[]) => void;
  /** Drop items outright by key (`h|id` / `r|homeId|address`): a
   *  deletion whose tombstone aged out — the server holds nothing. */
  forget: (keys: string[]) => void;
  /** The current cursor (the last change's sequence number). */
  cursor: () => number;
  calls: { method: string; path: string; body: unknown; query: Record<string, string> }[];
  devices: Map<string, FakeDevice>;
  removed: Set<string>;
  down: boolean;
  features: string[];
  serverId: string;
  publicHost: string | null;
  person: string;
  /** Answered as the pull's `redirects`. */
  redirects: Record<string, string>;
  /** Answered as the pull's `servers` (defaults to `{host: serverId}`). */
  servers: Record<string, string>;
  /** Tombstone floor: a `since` below it answers `full:true`. */
  floor: number;
  /** Force the next push to reject these keys. */
  rejectNext: string[];
  /** Drop every registration (a wiped server DB): pushes get 409. */
  forgetDevices: () => void;
}

function key(it: Item): string {
  return it.kind === "home" ? `h|${it.id}` : `r|${it.homeId}|${it.address}`;
}

/** The server's rule: later updatedAt, then the larger deviceId, then a
 *  tombstone on a full tie. */
function newer(a: Item, b: Item): boolean {
  const d = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
  if (d !== 0) return d > 0;
  const da = String(a.deviceId ?? "");
  const db = String(b.deviceId ?? "");
  if (da !== db) return da > db;
  return !!a.deleted && !b.deleted;
}

export function fakeHomesServer(
  host: string,
  opts: { serverId?: string; features?: string[]; publicHost?: string | null } = {}
): FakeHomesServer {
  const latest = new Map<string, { seq: number; item: Item }>();
  let seq = 0;
  const put = (item: Item, deviceId?: string): "applied" | "superseded" => {
    const k = key(item);
    const rec = deviceId ? { ...item, deviceId } : item;
    const held = latest.get(k);
    if (held && !newer(rec, held.item)) return "superseded";
    seq += 1;
    latest.set(k, { seq, item: rec });
    return "applied";
  };
  const reply = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const serverId = opts.serverId ?? "0123456789abcdef";
  const srv: FakeHomesServer = {
    host,
    calls: [],
    devices: new Map(),
    removed: new Set(),
    down: false,
    features: opts.features ?? ["homes-sync-v1"],
    serverId,
    publicHost: opts.publicHost === undefined ? host : opts.publicHost,
    person: "owner",
    redirects: {},
    servers: { [host]: serverId },
    floor: 0,
    rejectNext: [],
    items: () => [...latest.values()].map((r) => r.item),
    cursor: () => seq,
    seed: (items) => {
      for (const it of items) put(it, typeof it.deviceId === "string" ? it.deviceId : "other-device");
    },
    forget: (keys) => {
      for (const k of keys) latest.delete(k);
    },
    forgetDevices: () => {
      srv.devices.clear();
    },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      if (srv.down) throw new Error("offline");
      const method = init.method ?? "GET";
      const query = Object.fromEntries(u.searchParams.entries());
      const body = init.body ? JSON.parse(init.body) : null;
      srv.calls.push({ method, path: u.pathname, body, query });
      if (u.pathname === "/boot-status") {
        const b: Record<string, unknown> = { version: "0.46.1", features: srv.features, serverId: srv.serverId };
        if (srv.publicHost) b.publicHost = srv.publicHost;
        return reply(200, b);
      }
      if (u.pathname === "/cli/me/homes") {
        const dev = query.deviceId;
        if (dev && srv.removed.has(dev)) return reply(410, { ok: false, error: "device_removed" });
        const since = query.since !== undefined ? Number(query.since) : null;
        const full = since === null || !Number.isInteger(since) || since < srv.floor || since > seq;
        const changes = full
          ? [...latest.values()].filter((r) => !r.item.deleted).map((r) => r.item)
          : [...latest.values()].filter((r) => r.seq > (since as number)).sort((a, b) => a.seq - b.seq).map((r) => r.item);
        const d = dev ? srv.devices.get(dev) : undefined;
        if (d) d.lastSyncAt = Date.now();
        return reply(200, {
          ok: true,
          person: srv.person,
          serverId: srv.serverId,
          cursor: seq,
          full,
          changes,
          redirects: srv.redirects,
          device: { deviceId: dev ?? null, syncing: !!d },
          servers: srv.servers,
        });
      }
      if (u.pathname === "/cli/me/homes/push") {
        const dev = body?.deviceId as string;
        if (srv.removed.has(dev)) return reply(410, { ok: false, error: "device_removed" });
        if (!srv.devices.has(dev)) return reply(409, { ok: false, error: "device_not_registered" });
        const rejected: { item: Item; reason: string }[] = [];
        let applied = 0;
        let superseded = 0;
        const all = (body?.changes ?? []) as Item[];
        // Live items before tombstones (a new Home, then the old one goes).
        const ordered = [...all.filter((i) => !i.deleted), ...all.filter((i) => i.deleted)];
        for (const it of ordered) {
          if (srv.rejectNext.includes(key(it))) {
            rejected.push({ item: it, reason: "invalid" });
            continue;
          }
          if (!it.deleted && !isValidOrder(String(it.order ?? ""))) {
            rejected.push({ item: it, reason: "invalid_order" });
            continue;
          }
          if (put(it, dev) === "applied") applied += 1;
          else superseded += 1;
        }
        srv.rejectNext = [];
        return reply(200, { ok: true, cursor: seq, applied, superseded, rejected });
      }
      if (u.pathname === "/cli/me/homes/devices/register") {
        srv.removed.delete(body.deviceId);
        const d: FakeDevice = { ...body, registeredAt: Date.now(), lastSyncAt: null };
        srv.devices.set(body.deviceId, d);
        return reply(200, { ok: true, device: { ...d, current: false } });
      }
      if (u.pathname === "/cli/me/homes/devices") {
        return reply(200, { ok: true, devices: [...srv.devices.values()].map((d) => ({ ...d, current: false })) });
      }
      if (u.pathname === "/cli/me/homes/devices/remove") {
        if (!srv.devices.has(body.deviceId)) return reply(404, { ok: false, error: "unknown_device" });
        srv.devices.delete(body.deviceId);
        srv.removed.add(body.deviceId);
        return reply(200, { ok: true, removed: true, deviceId: body.deviceId });
      }
      return reply(404, { error: "not found" });
    },
  };
  return srv;
}
