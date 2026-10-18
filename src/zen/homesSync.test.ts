// @vitest-environment jsdom
// Homes sync engine (K2 0.46.1 `homes-sync-v1`) against an in-memory
// server: first sync, outbox, offline, frames, foreground, reconnect,
// 410, devices, move, disable. Home is always the local copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { emitServerSignal } from "../api/serverSignals";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { fakeHomesServer, type FakeHomesServer } from "../test/fakeHomesServer";
import { useHomeServerIds } from "./homeServerIds";
import { selectedHome, useHomesStore, type Home } from "./homes";
import {
  FRAME_DEBOUNCE_MS,
  HOMES_OUTBOX_KEY,
  HOMES_SYNC_META_KEY,
  HOMES_SYNC_SERVER_KEY,
  PUSH_DEBOUNCE_MS,
  RETRY_BASE_MS,
  __homesSyncCursor,
  __homesSyncRegistered,
  __resetHomesSyncForTests,
  disableHomesSync,
  enableHomesSync,
  homesSyncStatusText,
  loadHomesDevices,
  probeHomesSync,
  readOutbox,
  removeHomesSyncDevice,
  startHomesSync,
  syncHomesNow,
  useHomesSyncStore,
} from "./homesSync";

class MockWS {
  static instances: MockWS[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const PHONE = "phone-1";
let A: FakeHomesServer;
let B: FakeHomesServer;

function route() {
  tauriFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const host = new URL(url).host;
    if (host === A.host) return A.fetch(url, init);
    if (host === B.host) return B.fetch(url, init);
    throw new Error("offline");
  });
}

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

function local() {
  return useHomesStore.getState().homes.map((h) => ({ name: h.name, rows: h.rows.map((r) => r.address) }));
}

function desktopSeed(srv: FakeHomesServer) {
  srv.seed([
    { kind: "home", id: "srv-home", name: "Home", order: "V", updatedAt: 100 },
    { kind: "row", homeId: "srv-home", address: "docs::0123456789abcdef", label: "docs", workspaceId: "pd", order: "V", updatedAt: 100 },
    { kind: "home", id: "srv-work", name: "Work", order: "l", updatedAt: 100 },
    { kind: "row", homeId: "srv-work", address: "ops::0123456789abcdef", label: "ops", workspaceId: null, order: "V", updatedAt: 100 },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  __resetScopesForTests();
  A = fakeHomesServer("home.k2.dev", { serverId: "0123456789abcdef" });
  B = fakeHomesServer("work.k2.dev", { serverId: "fedcba9876543210" });
  tauriFetch.mockReset();
  route();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home box", url: "https://home.k2.dev", username: "r", rememberPassword: false },
      { id: "s2", nickname: "Work box", url: "https://work.k2.dev", username: "r", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "t1", s2: "t2" },
    hydrated: true,
  });
  useHomeServerIds.getState().reload();
  useHomesStore.getState().reload();
  __resetHomesSyncForTests({ deviceId: PHONE });
  startHomesSync();
});

afterEach(() => {
  __resetHomesSyncForTests({ deviceId: PHONE });
  useHomeServerIds.setState({ bySaved: {}, hostByBox: {}, hinted: {} });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("gate: homes-sync-v1", () => {
  it("probe reads /boot-status features; a server without the key never syncs", async () => {
    A.features = [];
    expect(await probeHomesSync("s1")).toBe(false);
    expect(useHomesSyncStore.getState().feature.s1).toBe(false);
    __resetScopesForTests();
    A.features = ["homes-sync-v1"];
    expect(await probeHomesSync("s1")).toBe(true);
  });

  it("turning it on against a server without the key refuses, touching nothing", async () => {
    A.features = [];
    const before = useHomesStore.getState().homes;
    expect(await enableHomesSync("s1")).toBe(false);
    expect(useHomesSyncStore.getState()).toMatchObject({ serverId: null, error: "Home box does not offer Home sync" });
    expect(A.calls.filter((c) => c.path.startsWith("/cli/me"))).toEqual([]);
    expect(useHomesStore.getState().homes).toBe(before);
  });

  it("dormant by default: no sync server, local edits queue nothing, no /cli/me calls", async () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "a::home.k2.dev", workspaceId: null, label: "a" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(useHomesSyncStore.getState().serverId).toBeNull();
    expect(localStorage.getItem(HOMES_OUTBOX_KEY)).toBeNull();
    expect(A.calls.filter((c) => c.path.startsWith("/cli/me"))).toEqual([]);
  });
});

describe("turning sync on (first sync)", () => {
  it("registers, unions same-name Homes into the server's id, pushes the union, never deletes", async () => {
    desktopSeed(A);
    const s = useHomesStore.getState();
    s.ensureSeeded();
    const localId = s.selectedId;
    s.addRow(localId, { address: "mine::home.k2.dev", workspaceId: null, label: "mine" });

    expect(await enableHomesSync("s1")).toBe(true);
    expect(A.devices.get(PHONE)).toMatchObject({ deviceId: PHONE, platform: expect.any(String), name: expect.any(String) });
    expect(localStorage.getItem(HOMES_SYNC_SERVER_KEY)).toBe("s1");

    const h = useHomesStore.getState();
    expect(h.homes.map((x) => x.id)).toEqual(["srv-home", "srv-work"]);
    expect(h.redirects).toEqual({ [localId]: "srv-home" });
    // selectedId followed the redirect; old id still resolves.
    expect(h.selectedId).toBe("srv-home");
    h.selectHome(localId);
    expect(useHomesStore.getState().selectedId).toBe("srv-home");
    // The phone's own row moved to the box id /boot-status reported
    // (hostKey → serverId migration) and comes first.
    expect(local()).toEqual([
      { name: "Home", rows: ["mine::0123456789abcdef", "docs::0123456789abcdef"] },
      { name: "Work", rows: ["ops::0123456789abcdef"] },
    ]);
    // The server now holds the phone's row too; nothing the server had
    // was deleted.
    expect(A.items().some((i) => i.address === "mine::0123456789abcdef" && !i.deleted)).toBe(true);
    expect(A.items().filter((i) => i.deleted).map((i) => i.address)).toEqual([]);
    const st = useHomesSyncStore.getState();
    expect(st.status).toBe("synced");
    expect(st.outbox).toEqual([]);
    expect(homesSyncStatusText(st)).toBe("Synced · just now");
  });

  it("a failed register leaves Homes and the setting untouched", async () => {
    A.down = true;
    const before = useHomesStore.getState().homes;
    expect(await enableHomesSync("s1")).toBe(false);
    expect(useHomesSyncStore.getState().serverId).toBeNull();
    expect(useHomesSyncStore.getState().error).toBe("Could not reach Home box");
    expect(useHomesStore.getState().homes).toBe(before);
  });
});

describe("steady state", () => {
  beforeEach(async () => {
    useHomesStore.getState().ensureSeeded();
    await enableHomesSync("s1");
    A.calls.length = 0;
  });

  it("every local edit is stamped, persisted in the outbox, then pushed and pulled", async () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "a::0123456789abcdef", workspaceId: "w", label: "a" });
    expect(readOutbox("s1")).toEqual([expect.objectContaining({ kind: "row", address: "a::0123456789abcdef", by: PHONE })]);
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(A.calls.map((c) => c.path)).toEqual(expect.arrayContaining(["/cli/me/homes/push", "/cli/me/homes"]));
    const pushIdx = A.calls.findIndex((c) => c.path === "/cli/me/homes/push");
    const pullIdx = A.calls.findIndex((c, i) => i > pushIdx && c.path === "/cli/me/homes");
    expect(pullIdx).toBeGreaterThan(pushIdx);
    expect(A.calls[pullIdx].query.deviceId).toBe(PHONE);
    expect(A.calls[pullIdx].query.since).toBeTruthy();
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    expect(localStorage.getItem(HOMES_OUTBOX_KEY)).toBeNull();
  });

  it("offline: Home still renders and edits; changes queue (persisted) and go out on reconnect", async () => {
    A.down = true;
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "off::0123456789abcdef", workspaceId: null, label: "off" });
    s.renameHome(s.selectedId, "Mine");
    // Home is the local copy: already there.
    expect(selectedHome(useHomesStore.getState())).toMatchObject({ name: "Mine" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(useHomesSyncStore.getState().status).toBe("offline");
    expect(homesSyncStatusText(useHomesSyncStore.getState())).toBe("Offline — changes will sync later");
    expect(readOutbox("s1")).toHaveLength(2);

    // A restart keeps the outbox.
    __resetHomesSyncForTests({ deviceId: PHONE });
    startHomesSync();
    expect(useHomesSyncStore.getState().outbox).toHaveLength(2);

    A.down = false;
    emitServerSignal("s1", "recovered");
    await flush(0);
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    expect(A.items().find((i) => i.kind === "home" && !i.deleted)?.name).toBe("Mine");
    expect(A.items().some((i) => i.address === "off::0123456789abcdef")).toBe(true);
  });

  it("retries with backoff after a failure", async () => {
    A.down = true;
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "r::0123456789abcdef", workspaceId: null, label: "r" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(useHomesSyncStore.getState().status).toBe("offline");
    A.down = false;
    await flush(RETRY_BASE_MS + 10);
    expect(useHomesSyncStore.getState().status).toBe("synced");
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
  });

  it("rejected items leave the outbox (logged) and a re-pull converges", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = useHomesStore.getState();
    A.rejectNext = [`r|${s.selectedId}|bad::0123456789abcdef`];
    s.addRow(s.selectedId, { address: "bad::0123456789abcdef", workspaceId: null, label: "bad" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[homes-sync] server rejected", expect.anything(), "invalid");
    expect(A.calls[A.calls.length - 1]?.path).toBe("/cli/me/homes");
    warn.mockRestore();
  });

  it("homes_changed on the person's socket pulls another device's edit", async () => {
    const hub = MockWS.instances.find((w) => w.url.startsWith("wss://home.k2.dev/cli/sessions/events"));
    expect(hub).toBeTruthy();
    hub!.onopen?.();
    const id = useHomesStore.getState().selectedId;
    A.seed([{ kind: "row", homeId: id, address: "fromdesk::0123456789abcdef", label: "desk", workspaceId: null, order: "x", updatedAt: Date.now() + 5 }]);
    hub!.deliver({ kind: "homes_changed" });
    await flush(FRAME_DEBOUNCE_MS + 10);
    expect(local()[0].rows).toContain("fromdesk::0123456789abcdef");
  });

  it("pulls on foreground and on a reopened socket", async () => {
    const pulls = () => A.calls.filter((c) => c.path === "/cli/me/homes").length;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(0);
    expect(pulls()).toBe(1);
    emitServerSignal("s1", "reopened");
    await flush(0);
    expect(pulls()).toBe(2);
    emitServerSignal("s2", "reopened"); // not the sync server
    await flush(0);
    expect(pulls()).toBe(2);
  });

  it("410 device_removed: stop syncing, keep Homes, one-time notice", async () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "keep::0123456789abcdef", workspaceId: null, label: "keep" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    const homes = useHomesStore.getState().homes;
    A.removed.add(PHONE);
    await syncHomesNow();
    const st = useHomesSyncStore.getState();
    expect(st.serverId).toBeNull();
    expect(st.notice).toEqual({ serverId: "s1", label: "Home box" });
    expect(homesSyncStatusText(st)).toBe("Not synced");
    expect(localStorage.getItem(HOMES_SYNC_SERVER_KEY)).toBeNull();
    expect(useHomesStore.getState().homes).toBe(homes);
    // No more calls after removal.
    A.calls.length = 0;
    s.addRow(s.selectedId, { address: "later::0123456789abcdef", workspaceId: null, label: "later" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(A.calls).toEqual([]);
  });

  it("homes_device_removed frame: this phone → off; another device → refresh the list", async () => {
    const hub = MockWS.instances.find((w) => w.url.startsWith("wss://home.k2.dev"))!;
    hub.onopen?.();
    await loadHomesDevices("s1");
    A.calls.length = 0;
    hub.deliver({ kind: "homes_device_removed", deviceId: "laptop" });
    await flush(0);
    expect(useHomesSyncStore.getState().serverId).toBe("s1");
    expect(A.calls.map((c) => c.path)).toEqual(["/cli/me/homes/devices"]);
    hub.deliver({ kind: "homes_device_removed", deviceId: PHONE });
    await flush(0);
    expect(useHomesSyncStore.getState().serverId).toBeNull();
    expect(useHomesSyncStore.getState().notice?.label).toBe("Home box");
  });

  it("devices: list marks this phone; removing another device keeps syncing", async () => {
    A.devices.set("laptop", { deviceId: "laptop", name: "MacBook", platform: "macos", lastSyncAt: 1 });
    await loadHomesDevices("s1");
    const list = useHomesSyncStore.getState().devices.s1!;
    expect(list.map((d) => [d.deviceId, d.current])).toEqual([
      [PHONE, true],
      ["laptop", false],
    ]);
    expect(await removeHomesSyncDevice("s1", "laptop")).toBe(true);
    expect(A.calls.some((c) => c.path === "/cli/me/homes/devices/remove" && (c.body as { deviceId: string }).deviceId === "laptop")).toBe(true);
    expect(useHomesSyncStore.getState().serverId).toBe("s1");
    await flush(0);
    expect(useHomesSyncStore.getState().devices.s1!.map((d) => d.deviceId)).toEqual([PHONE]);
  });

  it("turning it off removes this phone there and keeps the Homes exactly", async () => {
    const homes = useHomesStore.getState().homes;
    await disableHomesSync();
    expect(A.calls[A.calls.length - 1]).toMatchObject({ method: "POST", path: "/cli/me/homes/devices/remove", body: { deviceId: PHONE } });
    expect(useHomesSyncStore.getState()).toMatchObject({ serverId: null, status: "off", notice: null });
    expect(useHomesStore.getState().homes).toBe(homes);
  });

  it("moving to another server registers there and removes this phone from the old one", async () => {
    expect(await enableHomesSync("s2")).toBe(true);
    expect(useHomesSyncStore.getState().serverId).toBe("s2");
    expect(B.devices.has(PHONE)).toBe(true);
    await flush(0);
    expect(A.calls.some((c) => c.path === "/cli/me/homes/devices/remove")).toBe(true);
    expect(A.devices.has(PHONE)).toBe(false);
  });

  it("rows for a Home this phone never saw trigger a full re-pull", async () => {
    A.seed([{ kind: "row", homeId: "ghost", address: "g::x", label: "g", workspaceId: null, order: "V", updatedAt: 5 }]);
    A.calls.length = 0;
    await syncHomesNow();
    const pulls = A.calls.filter((c) => c.path === "/cli/me/homes");
    expect(pulls.length).toBe(2);
    expect(pulls[1].query.since).toBeUndefined();
  });
});

describe("K2 0.46.1 final contract", () => {
  const pulls = () => A.calls.filter((c) => c.path === "/cli/me/homes");
  const pushes = () => A.calls.filter((c) => c.path === "/cli/me/homes/push");

  beforeEach(async () => {
    useHomesStore.getState().ensureSeeded();
    await enableHomesSync("s1");
    A.calls.length = 0;
  });

  it("the cursor is an integer: stored as a number, sent back as since", async () => {
    const at = __homesSyncCursor();
    expect(typeof at).toBe("number");
    expect(at).toBe(A.cursor());
    expect(JSON.parse(localStorage.getItem(HOMES_SYNC_META_KEY)!)).toMatchObject({ serverId: "s1", cursor: at, registered: true });
    await syncHomesNow();
    expect(pulls()[0].query.since).toBe(String(at));
    // A cursor saved by the earlier build (a numeric string) still reads.
    localStorage.setItem(HOMES_SYNC_META_KEY, JSON.stringify({ serverId: "s1", cursor: "3", lastSyncAt: 1 }));
    __resetHomesSyncForTests({ deviceId: PHONE });
    expect(__homesSyncCursor()).toBe(3);
    expect(__homesSyncRegistered()).toBe(true);
  });

  it("superseded items leave the outbox (not an error) and a full re-pull brings the newer version", async () => {
    const id = useHomesStore.getState().selectedId;
    // Another device renamed this Home later than the phone's clock says.
    A.seed([{ kind: "home", id, name: "Desk name", order: "V", updatedAt: Date.now() + 60_000, deviceId: "desk-1" }]);
    const before = A.cursor();
    useHomesStore.getState().renameHome(id, "Phone name");
    await syncHomesNow();
    await flush(0);
    expect(useHomesSyncStore.getState().status).toBe("synced");
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    expect(pushes()).toHaveLength(1);
    const pull = pulls()[0];
    expect(pull.query.since).toBeUndefined();
    expect(A.cursor()).toBe(before);
    expect(selectedHome(useHomesStore.getState()).name).toBe("Desk name");
  });

  it("full:true (a since below the floor) is merged per item: nothing local is deleted", async () => {
    const h = useHomesStore.getState();
    const id = h.selectedId;
    // A row this phone holds that the server's live set lacks.
    h.applySynced({
      ...h.syncState(),
      homes: h.homes.map((x) => (x.id === id ? { ...x, rows: [...x.rows, { address: "only::here", workspaceId: null, label: "only", order: "x", updatedAt: 1 }] } : x)),
    });
    A.seed([{ kind: "row", homeId: id, address: "srv::0123456789abcdef", label: "srv", workspaceId: null, order: "t", updatedAt: Date.now() }]);
    A.floor = A.cursor() + 100; // our since is now stale
    await syncHomesNow();
    expect(pulls()[0].query.since).toBeTruthy();
    expect(local()[0].rows.sort()).toEqual(["only::here", "srv::0123456789abcdef"]);
    expect(__homesSyncCursor()).toBe(A.cursor());
    // An ahead cursor (a wiped server) also answers full and converges.
    A.floor = 0;
    localStorage.setItem(HOMES_SYNC_META_KEY, JSON.stringify({ serverId: "s1", cursor: 999, lastSyncAt: 1, registered: true }));
    __resetHomesSyncForTests({ deviceId: PHONE });
    startHomesSync();
    await flush(0);
    expect(__homesSyncCursor()).toBe(A.cursor());
    expect(local()[0].rows).toContain("only::here");
  });

  it("pull redirects: the local Home folds into the new id; selection and queued rows follow", async () => {
    const oldId = useHomesStore.getState().selectedId;
    A.down = true;
    useHomesStore.getState().addRow(oldId, { address: "queued::0123456789abcdef", workspaceId: null, label: "q" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(readOutbox("s1").some((c) => c.kind === "row" && c.homeId === oldId)).toBe(true);
    // Meanwhile the desktop merged this Home into h1.
    A.seed([
      { kind: "home", id: "h1", name: "Home", order: "V", updatedAt: Date.now(), deviceId: "desk-1" },
      { kind: "row", homeId: "h1", address: "desk::0123456789abcdef", label: "desk", workspaceId: null, order: "V", updatedAt: Date.now(), deviceId: "desk-1" },
    ]);
    A.redirects = { [oldId]: "h1" };
    A.down = false;
    // Pull first (an empty-outbox run would push; drive it explicitly).
    emitServerSignal("s1", "recovered");
    await flush(0);
    await flush(0);
    const h = useHomesStore.getState();
    expect(h.redirects[oldId]).toBe("h1");
    expect(h.selectedId).toBe("h1");
    expect(h.homes.map((x) => x.id)).toEqual(["h1"]);
    h.selectHome(oldId);
    expect(useHomesStore.getState().selectedId).toBe("h1");
    // The queued row went out (or will) under h1, never the old id.
    expect(useHomesSyncStore.getState().outbox.every((c) => c.kind !== "row" || c.homeId === "h1")).toBe(true);
    await syncHomesNow();
    expect(A.items().some((i) => i.homeId === "h1" && i.address === "queued::0123456789abcdef")).toBe(true);
    expect(local()[0].rows.sort()).toEqual(["desk::0123456789abcdef", "queued::0123456789abcdef"]);
  });

  it("a Home tombstone with mergedInto moves rows and selection to that Home", async () => {
    const oldId = useHomesStore.getState().selectedId;
    useHomesStore.getState().addRow(oldId, { address: "mine::0123456789abcdef", workspaceId: null, label: "mine" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    A.seed([
      { kind: "home", id: "h1", name: "Home", order: "V", updatedAt: Date.now() + 10, deviceId: "desk-1" },
      { kind: "home", id: oldId, name: "", order: "", updatedAt: Date.now() + 10, deviceId: "desk-1", deleted: true, mergedInto: "h1" },
    ]);
    await syncHomesNow();
    const h = useHomesStore.getState();
    expect(h.homes.map((x) => x.id)).toEqual(["h1"]);
    expect(h.selectedId).toBe("h1");
    expect(h.redirects).toEqual({ [oldId]: "h1" });
    expect(local()).toEqual([{ name: "Home", rows: ["mine::0123456789abcdef"] }]);
  });

  it("the pull's servers map migrates rows for a server whose /boot-status was never read", async () => {
    A.servers = { "home.k2.dev": "0123456789abcdef", "work.k2.dev": "fedcba9876543210" };
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "docs::work.k2.dev", workspaceId: null, label: "docs" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(B.calls.filter((c) => c.path === "/boot-status")).toEqual([]);
    expect(local()[0].rows).toEqual(["docs::fedcba9876543210"]);
    expect(useHomeServerIds.getState().bySaved.s2).toBe("fedcba9876543210");
    await syncHomesNow();
    expect(A.items().some((i) => i.address === "docs::fedcba9876543210" && !i.deleted)).toBe(true);
  });

  it("push 409 device_not_registered: register, then retry the push once", async () => {
    A.forgetDevices();
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "r::0123456789abcdef", workspaceId: null, label: "r" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(A.calls.map((c) => c.path).filter((p) => p !== "/boot-status")).toEqual([
      "/cli/me/homes/push",
      "/cli/me/homes/devices/register",
      "/cli/me/homes/push",
      "/cli/me/homes",
    ]);
    expect(A.devices.has(PHONE)).toBe(true);
    expect(useHomesSyncStore.getState()).toMatchObject({ serverId: "s1", status: "synced", outbox: [] });
    expect(A.items().some((i) => i.address === "r::0123456789abcdef")).toBe(true);
  });

  it("syncing:false (not registered yet) is not a removal: the phone registers and keeps syncing", async () => {
    A.forgetDevices();
    await syncHomesNow();
    const st = useHomesSyncStore.getState();
    expect(st.serverId).toBe("s1");
    expect(st.notice).toBeNull();
    expect(localStorage.getItem(HOMES_SYNC_SERVER_KEY)).toBe("s1");
    // The next run registered it again.
    expect(A.calls.map((c) => c.path)).toContain("/cli/me/homes/devices/register");
    expect(A.devices.has(PHONE)).toBe(true);
    expect(__homesSyncRegistered()).toBe(true);
  });

  it("a removed frame for this phone before it registered is ignored; after, it stops sync", async () => {
    const hub = MockWS.instances.find((w) => w.url.startsWith("wss://home.k2.dev"))!;
    hub.onopen?.();
    // Unregistered: the server reports syncing:false and is unreachable
    // for the register that would follow.
    A.forgetDevices();
    const realFetch = A.fetch;
    A.fetch = async (url, init) => (new URL(url).pathname === "/cli/me/homes/devices/register" ? Promise.reject(new Error("offline")) : realFetch(url, init));
    await syncHomesNow();
    expect(__homesSyncRegistered()).toBe(false);
    hub.deliver({ kind: "homes_device_removed", deviceId: PHONE });
    await flush(0);
    expect(useHomesSyncStore.getState().serverId).toBe("s1");
    expect(useHomesSyncStore.getState().notice).toBeNull();
    // Registered again, then removed: now it stops.
    A.fetch = realFetch;
    await flush(RETRY_BASE_MS * 4);
    expect(__homesSyncRegistered()).toBe(true);
    hub.deliver({ kind: "homes_device_removed", deviceId: PHONE });
    await flush(0);
    expect(useHomesSyncStore.getState().serverId).toBeNull();
    expect(useHomesSyncStore.getState().notice?.label).toBe("Home box");
  });

  it("homes_changed with a cursor at or below ours skips the pull; a newer one pulls", async () => {
    const hub = MockWS.instances.find((w) => w.url.startsWith("wss://home.k2.dev"))!;
    hub.onopen?.();
    const at = __homesSyncCursor()!;
    hub.deliver({ kind: "homes_changed", cursor: at });
    hub.deliver({ kind: "homes_changed", cursor: at - 1 });
    await flush(FRAME_DEBOUNCE_MS + 10);
    expect(pulls()).toHaveLength(0);
    A.seed([{ kind: "home", id: "new", name: "New", order: "x", updatedAt: Date.now(), deviceId: "desk-1" }]);
    hub.deliver({ kind: "homes_changed", cursor: A.cursor() });
    await flush(FRAME_DEBOUNCE_MS + 10);
    expect(pulls()).toHaveLength(1);
    expect(local().map((h) => h.name)).toContain("New");
    expect(__homesSyncCursor()).toBe(A.cursor());
  });

  it("the device list arrives wrapped ({ok, devices}) and still marks this phone", async () => {
    A.devices.set("desk-1", { deviceId: "desk-1", name: "MacBook", platform: "macos", lastSyncAt: 5 });
    await loadHomesDevices("s1");
    expect(useHomesSyncStore.getState().devices.s1!.map((d) => [d.deviceId, d.current])).toEqual([
      [PHONE, true],
      ["desk-1", false],
    ]);
  });
});

describe("full resync: drop what the server no longer holds (K2 rule, as desktop)", () => {
  const SRV = "0123456789abcdef";
  const pushes = () => A.calls.filter((c) => c.path === "/cli/me/homes/push");
  const pulls = () => A.calls.filter((c) => c.path === "/cli/me/homes");
  const homeOf = (id: string) => useHomesStore.getState().homes.find((h) => h.id === id);
  const rowOf = (id: string, address: string) => homeOf(id)?.rows.find((r) => r.address === address);
  /** Make the next pull answer `full:true` (our cursor is below the floor). */
  const forceFull = () => {
    A.floor = A.cursor() + 100;
  };
  /** Add rows / Homes this phone holds but never sent (no mark, no outbox). */
  const injectLocal = (fn: (homes: Home[]) => Home[]) => {
    const h = useHomesStore.getState();
    h.applySynced({ ...h.syncState(), homes: fn(h.homes) });
  };
  let id = "";

  beforeEach(async () => {
    useHomesStore.getState().ensureSeeded();
    await enableHomesSync("s1");
    id = useHomesStore.getState().selectedId;
    useHomesStore.getState().addRow(id, { address: `kept::${SRV}`, workspaceId: null, label: "kept" });
    useHomesStore.getState().addRow(id, { address: `gone::${SRV}`, workspaceId: null, label: "gone" });
    await syncHomesNow();
    A.calls.length = 0;
  });

  it("marks what the server has seen (first sync, pushed items) and persists the mark", () => {
    expect(homeOf(id)?.synced).toBe(true);
    expect(rowOf(id, `gone::${SRV}`)?.synced).toBe(true);
    const doc = JSON.parse(localStorage.getItem("k2.homes.v1")!);
    expect(doc.homes[0].rows.every((r: { synced?: boolean }) => r.synced === true)).toBe(true);
  });

  it("a full resync drops a synced row and a synced Home the server lacks, with no tombstone push", async () => {
    const trip = useHomesStore.getState().createHome("Trip")!;
    useHomesStore.getState().addRow(trip, { address: `t::${SRV}`, workspaceId: null, label: "t" });
    await syncHomesNow();
    expect(homeOf(trip)?.synced).toBe(true);
    A.calls.length = 0;
    // Deleted elsewhere > 90 days ago: the tombstones aged out.
    A.forget([`r|${id}|gone::${SRV}`, `h|${trip}`, `r|${trip}|t::${SRV}`]);
    forceFull();
    await syncHomesNow();
    expect(pulls()[0].query.since).toBeTruthy();
    expect(local()).toEqual([{ name: "Home", rows: [`kept::${SRV}`] }]);
    const h = useHomesStore.getState();
    expect(h.tombstones.filter((t) => (t.kind === "home" ? t.id === trip : t.address === `gone::${SRV}`))).toEqual([]);
    expect(pushes()).toEqual([]);
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    expect(A.items().some((i) => i.address === `gone::${SRV}` || i.id === trip)).toBe(false);
  });

  it("a full resync keeps and pushes a never-synced local item", async () => {
    injectLocal((homes) =>
      homes.map((x) =>
        x.id === id ? { ...x, rows: [...x.rows, { address: `offline::${SRV}`, workspaceId: null, label: "offline", order: "x", updatedAt: 5 }] } : x
      )
    );
    forceFull();
    await syncHomesNow();
    expect(local()[0].rows).toContain(`offline::${SRV}`);
    expect(pushes().some((p) => JSON.stringify(p.body).includes(`offline::${SRV}`))).toBe(true);
    expect(A.items().some((i) => i.address === `offline::${SRV}` && !i.deleted)).toBe(true);
    // Accepted: now synced.
    expect(rowOf(id, `offline::${SRV}`)?.synced).toBe(true);
  });

  it("a synced Home the server lacks is kept when it holds local-only rows (its synced rows go)", async () => {
    A.forget([`h|${id}`, `r|${id}|kept::${SRV}`, `r|${id}|gone::${SRV}`]);
    injectLocal((homes) =>
      homes.map((x) =>
        x.id === id ? { ...x, rows: [...x.rows, { address: `new::${SRV}`, workspaceId: null, label: "new", order: "x", updatedAt: 5 }] } : x
      )
    );
    forceFull();
    await syncHomesNow();
    expect(local()).toEqual([{ name: "Home", rows: [`new::${SRV}`] }]);
    // The Home and its local-only row went back to the server.
    expect(A.items().some((i) => i.kind === "home" && i.id === id && !i.deleted)).toBe(true);
    expect(A.items().some((i) => i.homeId === id && i.address === `new::${SRV}` && !i.deleted)).toBe(true);
    expect(A.items().some((i) => i.address === `kept::${SRV}` || i.address === `gone::${SRV}`)).toBe(false);
  });

  it("unmarked legacy items (saved before the mark) are kept and pushed", async () => {
    // Strip every mark, as a doc written by the previous build reads.
    injectLocal((homes) =>
      homes.map(({ synced: _s, ...x }) => ({ ...x, rows: x.rows.map(({ synced: _r, ...r }) => r) }))
    );
    expect(homeOf(id)?.synced).toBeUndefined();
    A.forget([`h|${id}`, `r|${id}|kept::${SRV}`, `r|${id}|gone::${SRV}`]);
    forceFull();
    await syncHomesNow();
    expect(local()).toEqual([{ name: "Home", rows: [`kept::${SRV}`, `gone::${SRV}`] }]);
    expect(A.items().filter((i) => !i.deleted).length).toBe(3);
  });

  it("a rejected push does not mark the item; the full re-pull keeps it without re-sending it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    A.rejectNext = [`r|${id}|bad::${SRV}`];
    useHomesStore.getState().addRow(id, { address: `bad::${SRV}`, workspaceId: null, label: "bad" });
    await syncHomesNow();
    await flush(0);
    expect(rowOf(id, `bad::${SRV}`)).toBeDefined();
    expect(rowOf(id, `bad::${SRV}`)?.synced).toBeUndefined();
    // The rejection made the next pull a full one: kept, and not queued
    // again (the same write would be rejected again).
    expect(pulls().some((p) => p.query.since === undefined)).toBe(true);
    expect(pushes()).toHaveLength(1);
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    warn.mockRestore();
  });

  it("an incremental (non-full) pull never drops anything", async () => {
    A.forget([`r|${id}|gone::${SRV}`]);
    await syncHomesNow();
    expect(pulls()[0].query.since).toBe(String(A.cursor()));
    expect(local()[0].rows).toContain(`gone::${SRV}`);
  });

  it("a server that looks wiped (cursor went back) drops nothing", async () => {
    A.forget([`r|${id}|gone::${SRV}`]);
    localStorage.setItem(HOMES_SYNC_META_KEY, JSON.stringify({ serverId: "s1", cursor: 999, lastSyncAt: 1, registered: true }));
    __resetHomesSyncForTests({ deviceId: PHONE });
    startHomesSync();
    await flush(0);
    expect(__homesSyncCursor()).toBe(A.cursor());
    expect(local()[0].rows).toContain(`gone::${SRV}`);
  });
});

describe("address migration wiring", () => {
  it("learning a box id from /boot-status migrates rows (and queues them when syncing)", async () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "docs::work.k2.dev", workspaceId: null, label: "docs" });
    noteBootStatus("s2", { version: "0.46.1", serverId: "fedcba9876543210" });
    expect(local()[0].rows).toEqual(["docs::fedcba9876543210"]);
  });
});
