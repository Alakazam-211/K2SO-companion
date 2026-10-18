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
import { selectedHome, useHomesStore } from "./homes";
import {
  FRAME_DEBOUNCE_MS,
  HOMES_OUTBOX_KEY,
  HOMES_SYNC_SERVER_KEY,
  PUSH_DEBOUNCE_MS,
  RETRY_BASE_MS,
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
    { kind: "home", id: "srv-home", name: "Home", order: "a0", updatedAt: 100 },
    { kind: "row", homeId: "srv-home", address: "docs::0123456789abcdef", label: "docs", workspaceId: "pd", order: "a0", updatedAt: 100 },
    { kind: "home", id: "srv-work", name: "Work", order: "a1", updatedAt: 100 },
    { kind: "row", homeId: "srv-work", address: "ops::0123456789abcdef", label: "ops", workspaceId: null, order: "a0", updatedAt: 100 },
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
  useHomeServerIds.setState({ bySaved: {}, hostByBox: {} });
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
    A.seed([{ kind: "row", homeId: id, address: "fromdesk::0123456789abcdef", label: "desk", workspaceId: null, order: "a5", updatedAt: Date.now() + 5 }]);
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
    A.seed([{ kind: "row", homeId: "ghost", address: "g::x", label: "g", workspaceId: null, order: "a0", updatedAt: 5 }]);
    A.calls.length = 0;
    await syncHomesNow();
    const pulls = A.calls.filter((c) => c.path === "/cli/me/homes");
    expect(pulls.length).toBe(2);
    expect(pulls[1].query.since).toBeUndefined();
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
