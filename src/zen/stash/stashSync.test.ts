// @vitest-environment jsdom
// Stash sync engine (K2 0.46.7 `stash-sync-v1`) against an in-memory
// server that follows the pinned contract: first sync, local saves and
// deletes, frames, full pulls, the cap, 409, and an older server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StashItem } from "./stashModel";

const api = vi.hoisted(() => ({
  boot: vi.fn(),
  register: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
}));

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  getBootStatus: (...a: unknown[]) => api.boot(...a),
}));
vi.mock("../../api/scope", async (orig) => ({
  ...(await orig<typeof import("../../api/scope")>()),
  scopeFor: (id: string) => ({ id, token: () => "tok" }),
}));
vi.mock("../../api/homesSync", async (orig) => ({
  ...(await orig<typeof import("../../api/homesSync")>()),
  registerHomesDevice: (...a: unknown[]) => api.register(...a),
}));
vi.mock("../../api/stashSync", async (orig) => ({
  ...(await orig<typeof import("../../api/stashSync")>()),
  pullStash: (...a: unknown[]) => api.pull(...a),
  pushStash: (...a: unknown[]) => api.push(...a),
}));

import { emitStashFrame } from "../../api/stashSync";
import { PUSH_DEBOUNCE_MS, __resetHomesSyncForTests, useHomesSyncStore } from "../homesSync";
import { memoryStashBackend } from "./stashBackend";
import { liveStash, makeStashItem, stashWins, STASH_MAX } from "./stashModel";
import { __resetStashForTests, useStashStore } from "./stashStore";
import { STASH_SYNC_KEY, __resetStashSyncForTests, __stashSyncMeta, startStashSync, syncStashNow, useStashSyncStore } from "./stashSync";

/** The contract's server, in memory. */
function fakeServer() {
  const rows = new Map<string, { item: StashItem; seq: number }>();
  let cursor = 0;
  const registered = new Set<string>();
  const live = () => [...rows.values()].filter((r) => r.item.deleted_at == null).length;
  const store = (item: StashItem, by: string) => {
    cursor += 1;
    const kept = item.deleted_at != null ? { ...item, text: "", attachments: [], quotes: [] } : item;
    rows.set(item.id, { item: { ...kept, updated_by: by }, seq: cursor });
  };
  return {
    rows,
    registered,
    get cursor() {
      return cursor;
    },
    seed(item: StashItem, by = "mac-1") {
      store(item, by);
    },
    pull(_scope: unknown, _device: string, since: number | null) {
      if (since === null || since > cursor) {
        const changes = [...rows.values()].filter((r) => r.item.deleted_at == null).map((r) => r.item);
        return Promise.resolve({ ok: true, data: { cursor, full: true, changes } });
      }
      const changes = [...rows.values()]
        .filter((r) => r.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => r.item);
      return Promise.resolve({ ok: true, data: { cursor, full: false, changes } });
    },
    push(_scope: unknown, device: string, changes: StashItem[]) {
      if (!registered.has(device)) {
        return Promise.resolve({ ok: false, kind: "not_registered", status: 409, error: "device_not_registered" });
      }
      let applied = 0;
      let superseded = 0;
      const rejected: { id: string; reason: string }[] = [];
      // Tombstones first.
      const ordered = [...changes].sort((a, b) => Number(b.deleted_at != null) - Number(a.deleted_at != null));
      for (const c of ordered) {
        const cur = rows.get(c.id)?.item;
        const sent = { ...c, updated_by: device };
        if (cur && !stashWins(sent, cur)) {
          superseded += 1;
          continue;
        }
        const becomesLive = c.deleted_at == null && (!cur || cur.deleted_at != null);
        if (becomesLive && live() >= 50) {
          rejected.push({ id: c.id, reason: "cap_reached" });
          continue;
        }
        store(c, device);
        applied += 1;
      }
      return Promise.resolve({ ok: true, data: { cursor, applied, superseded, rejected } });
    },
  };
}

let srv: ReturnType<typeof fakeServer>;
const st = () => useStashStore.getState();
const texts = () => liveStash(st().items).map((i) => i.text).sort();
const serverTexts = () =>
  [...srv.rows.values()]
    .filter((r) => r.item.deleted_at == null)
    .map((r) => r.item.text)
    .sort();
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  localStorage.clear();
  srv = fakeServer();
  srv.registered.add("phone-1");
  api.boot.mockReset().mockResolvedValue({ features: ["homes-sync-v1", "stash-sync-v1"], featuresKnown: true });
  api.register.mockReset().mockImplementation((_s: unknown, d: { deviceId: string }) => {
    srv.registered.add(d.deviceId);
    return Promise.resolve({ ok: true, data: {} });
  });
  api.pull.mockReset().mockImplementation((...a: Parameters<typeof srv.pull>) => srv.pull(...a));
  api.push.mockReset().mockImplementation((...a: Parameters<typeof srv.push>) => srv.push(...a));
  __resetHomesSyncForTests({ deviceId: "phone-1" });
  __resetStashForTests(memoryStashBackend());
  __resetStashSyncForTests();
  startStashSync();
});

afterEach(() => {
  __resetStashSyncForTests();
  vi.useRealTimers();
});

function homeSyncOn() {
  useHomesSyncStore.setState({ serverId: "srv" });
}

describe("stash sync", () => {
  it("does nothing while Home sync is off", async () => {
    await st().save({ text: "local only" });
    await flush(PUSH_DEBOUNCE_MS);
    await syncStashNow();
    expect(api.push).not.toHaveBeenCalled();
    expect(useStashSyncStore.getState().status).toBe("off");
  });

  it("first sync: everything here goes up, everything there comes down", async () => {
    await st().save({ text: "from phone" });
    srv.seed(makeStashItem({ text: "from desk", now: 50, by: "mac-1" }));
    homeSyncOn();
    await syncStashNow();
    expect(texts()).toEqual(["from desk", "from phone"]);
    expect(serverTexts()).toEqual(["from desk", "from phone"]);
    expect(__stashSyncMeta()).toMatchObject({ serverId: "srv", cursor: srv.cursor, outbox: [] });
    expect(useStashSyncStore.getState().status).toBe("synced");
    // The pushed record names this phone.
    const mine = [...srv.rows.values()].find((r) => r.item.text === "from phone")!.item;
    expect(mine.updated_by).toBe("phone-1");
    expect(JSON.parse(localStorage.getItem(STASH_SYNC_KEY)!).cursor).toBe(srv.cursor);
  });

  it("a save and a delete here are pushed shortly after", async () => {
    homeSyncOn();
    await flush();
    await st().save({ text: "new one" });
    expect(serverTexts()).toEqual([]);
    await flush(PUSH_DEBOUNCE_MS);
    expect(serverTexts()).toEqual(["new one"]);
    await st().remove(liveStash(st().items)[0].id);
    await flush(PUSH_DEBOUNCE_MS);
    expect(serverTexts()).toEqual([]);
    expect([...srv.rows.values()][0].item.deleted_at).not.toBeNull();
  });

  it("stash_changed with another cursor pulls: a delete elsewhere lands here", async () => {
    const shared = makeStashItem({ text: "shared", now: 50, by: "mac-1" });
    srv.seed(shared);
    homeSyncOn();
    await flush();
    expect(texts()).toEqual(["shared"]);
    // The desk deletes it.
    srv.seed({ ...shared, updated_at: 60, deleted_at: 60 });
    // Our own cursor: nothing to do.
    api.pull.mockClear();
    emitStashFrame("srv", { kind: "stash_changed", cursor: srv.cursor });
    await flush(PUSH_DEBOUNCE_MS);
    expect(api.pull).toHaveBeenCalledTimes(1);
    expect(texts()).toEqual([]);
    api.pull.mockClear();
    emitStashFrame("srv", { kind: "stash_changed", cursor: srv.cursor });
    await flush(PUSH_DEBOUNCE_MS);
    expect(api.pull).not.toHaveBeenCalled();
  });

  it("a full pull drops records the server no longer holds, but keeps ones still waiting to go", async () => {
    const gone = makeStashItem({ text: "aged out", now: 50, by: "mac-1" });
    srv.seed(gone);
    homeSyncOn();
    await syncStashNow();
    expect(texts()).toEqual(["aged out"]);
    // Its tombstone aged out on the server; our cursor is past its floor.
    srv.rows.delete(gone.id);
    api.push.mockResolvedValueOnce({ ok: false, kind: "offline", error: "offline" });
    await st().save({ text: "unsent" });
    api.pull.mockImplementationOnce((s: unknown, d: string) => srv.pull(s, d, null));
    await syncStashNow(); // push fails: the outbox keeps "unsent"
    await syncStashNow(); // full pull
    expect(texts()).toEqual(["unsent"]);
    expect(serverTexts()).toEqual(["unsent"]);
  });

  it("an older server version never overwrites a newer local delete", async () => {
    const it1 = makeStashItem({ text: "keep?", now: 50, by: "mac-1" });
    srv.seed(it1);
    homeSyncOn();
    await syncStashNow();
    await st().remove(it1.id);
    // A stale full pull still has it live.
    api.push.mockResolvedValueOnce({ ok: false, kind: "offline", error: "offline" });
    await syncStashNow();
    expect(texts()).toEqual([]);
    await syncStashNow();
    expect(texts()).toEqual([]);
    expect(serverTexts()).toEqual([]);
  });

  it("cap_reached: the record stays here, shown as not synced, and goes again later", async () => {
    for (let i = 0; i < STASH_MAX; i++) srv.seed(makeStashItem({ text: `d${i}`, now: 10 + i, by: "mac-1" }));
    homeSyncOn();
    await syncStashNow();
    expect(texts()).toHaveLength(STASH_MAX);
    const r = await st().save({ text: "51st" }, { replaceOldest: true });
    expect(r).toBe("saved");
    // Saving here removed the oldest and added one: tombstones first, so it fits.
    await syncStashNow();
    expect(serverTexts()).toContain("51st");
    expect(useStashSyncStore.getState().unsynced).toEqual({});

    // The desk fills the server again before our next save reaches it.
    const extra = makeStashItem({ text: "desk 52", now: Date.now() + 1, by: "mac-1" });
    srv.seed(extra);
    const oldest = [...srv.rows.values()].find((x) => x.item.text === "d1")!.item;
    srv.seed({ ...oldest, updated_at: Date.now() + 2, deleted_at: Date.now() + 2 });
    srv.seed(makeStashItem({ text: "desk 53", now: Date.now() + 3, by: "mac-1" }));
    await st().save({ text: "refused" }, { replaceOldest: true });
    await syncStashNow();
    const id = liveStash(st().items).find((i) => i.text === "refused")?.id;
    expect(id).toBeTruthy();
    expect(useStashSyncStore.getState().unsynced[id!]).toBe("cap_reached");
    expect(__stashSyncMeta()?.outbox).toContain(id);
  });

  it("409 device_not_registered: registers in the Homes registry and pushes again", async () => {
    srv.registered.clear();
    await st().save({ text: "hello" });
    homeSyncOn();
    await syncStashNow();
    expect(api.register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deviceId: "phone-1" }));
    expect(serverTexts()).toEqual(["hello"]);
  });

  it("a server without stash-sync-v1 keeps the stash on this phone", async () => {
    api.boot.mockResolvedValue({ features: ["homes-sync-v1"], featuresKnown: true });
    await st().save({ text: "here" });
    homeSyncOn();
    await syncStashNow();
    expect(api.push).not.toHaveBeenCalled();
    expect(api.pull).not.toHaveBeenCalled();
    expect(useStashSyncStore.getState().status).toBe("off");
  });

  it("turning Home sync on starts a sync", async () => {
    await st().save({ text: "x" });
    await flush();
    expect(api.push).not.toHaveBeenCalled();
    homeSyncOn();
    await flush();
    expect(serverTexts()).toEqual(["x"]);
  });
});
