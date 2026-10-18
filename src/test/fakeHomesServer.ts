// A tiny in-memory K2 0.46.1 Homes-sync server for tests: boot-status,
// `/cli/me/homes` (pull with a cursor), push (last-writer-wins per key),
// devices register / list / remove, and 410 for a removed device. Hand
// `fetch` to the mocked `@tauri-apps/plugin-http`.

type Item = Record<string, unknown>;

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
  /** Seed items as another device would have pushed them. */
  seed: (items: Item[]) => void;
  calls: { method: string; path: string; body: unknown; query: Record<string, string> }[];
  devices: Map<string, { deviceId: string; name: string; platform: string; lastSyncAt: number | null }>;
  removed: Set<string>;
  down: boolean;
  features: string[];
  serverId: string;
  /** Force the next push to reject these keys. */
  rejectNext: string[];
}

function key(it: Item): string {
  return it.kind === "home" ? `h|${it.id}` : `r|${it.homeId}|${it.address}`;
}

function newer(a: Item, b: Item): boolean {
  const d = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
  if (d !== 0) return d > 0;
  return !!a.deleted && !b.deleted;
}

export function fakeHomesServer(host: string, opts: { serverId?: string; features?: string[] } = {}): FakeHomesServer {
  const log: { seq: number; item: Item }[] = [];
  const latest = new Map<string, { seq: number; item: Item }>();
  let seq = 0;
  const put = (item: Item, deviceId?: string) => {
    const k = key(item);
    const held = latest.get(k);
    if (held && !newer(item, held.item)) return false;
    seq += 1;
    const rec = { seq, item: deviceId ? { ...item, deviceId } : item };
    latest.set(k, rec);
    log.push(rec);
    return true;
  };
  const reply = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const srv: FakeHomesServer = {
    host,
    calls: [],
    devices: new Map(),
    removed: new Set(),
    down: false,
    features: opts.features ?? ["homes-sync-v1"],
    serverId: opts.serverId ?? "0123456789abcdef",
    rejectNext: [],
    items: () => [...latest.values()].map((r) => r.item),
    seed: (items) => {
      for (const it of items) put(it, typeof it.deviceId === "string" ? it.deviceId : "other-device");
    },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      if (srv.down) throw new Error("offline");
      const method = init.method ?? "GET";
      const query = Object.fromEntries(u.searchParams.entries());
      const body = init.body ? JSON.parse(init.body) : null;
      srv.calls.push({ method, path: u.pathname, body, query });
      if (u.pathname === "/boot-status") {
        return reply(200, { version: "0.46.1", features: srv.features, serverId: srv.serverId });
      }
      if (u.pathname === "/cli/me/homes") {
        const dev = query.deviceId;
        if (dev && srv.removed.has(dev)) return reply(410, { error: "device_removed" });
        const since = query.since ? Number(query.since) : 0;
        const out = [...latest.values()].filter((r) => r.seq > since).map((r) => r.item);
        const d = dev ? srv.devices.get(dev) : undefined;
        if (d) d.lastSyncAt = Date.now();
        return reply(200, { homes: out, cursor: String(seq), device: { syncing: !!d } });
      }
      if (u.pathname === "/cli/me/homes/push") {
        const dev = body?.deviceId as string;
        if (srv.removed.has(dev)) return reply(410, { error: "device_removed" });
        const rejected: { item: Item; reason: string }[] = [];
        let applied = 0;
        for (const it of (body?.changes ?? []) as Item[]) {
          if (srv.rejectNext.includes(key(it))) {
            rejected.push({ item: it, reason: "invalid" });
            continue;
          }
          if (put(it, dev)) applied += 1;
        }
        srv.rejectNext = [];
        return reply(200, { cursor: String(seq), applied, rejected });
      }
      if (u.pathname === "/cli/me/homes/devices/register") {
        srv.removed.delete(body.deviceId);
        srv.devices.set(body.deviceId, { ...body, lastSyncAt: null });
        return reply(200, { ok: true });
      }
      if (u.pathname === "/cli/me/homes/devices") {
        return reply(200, [...srv.devices.values()].map((d) => ({ ...d, current: false })));
      }
      if (u.pathname === "/cli/me/homes/devices/remove") {
        srv.devices.delete(body.deviceId);
        srv.removed.add(body.deviceId);
        return reply(200, { ok: true });
      }
      return reply(404, { error: "not found" });
    },
  };
  return srv;
}
