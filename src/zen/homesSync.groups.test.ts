// @vitest-environment jsdom
// Homes sync with Home groups (K2 0.46.13, migrations 0305/0306) against
// an in-memory server: group fields round-trip on a 0.46.13 server; an
// older (0.46.12) server drops them and the phone keeps what it knows; a
// person / channel row an older server refuses (`invalid_kind`) stays on
// the phone and goes again once a pull lists its kind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { fakeHomesServer, type FakeHomesServer } from "../test/fakeHomesServer";
import { useHomeServerIds } from "./homeServerIds";
import { useHomesStore } from "./homes";
import { rowChange } from "./homesMerge";
import {
  HOMES_LOCAL_ONLY_KEY,
  HOMES_OUTBOX_KEY,
  HOMES_SYNC_META_KEY,
  PUSH_DEBOUNCE_MS,
  __homesSyncLocalOnly,
  __resetHomesSyncForTests,
  enableHomesSync,
  startHomesSync,
  syncHomesNow,
  useHomesSyncStore,
} from "./homesSync";

class MockWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

const PHONE = "phone-1";
const SRV = "0123456789abcdef";
let A: FakeHomesServer;

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

function start(groups: boolean) {
  A = fakeHomesServer("home.k2.dev", { serverId: SRV, groups });
  tauriFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => A.fetch(url, init));
}

function pushedItems() {
  return A.calls.filter((c) => c.path === "/cli/me/homes/push").flatMap((c) => (c.body as { changes: Record<string, unknown>[] }).changes);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  __resetScopesForTests();
  tauriFetch.mockReset();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home box", url: "https://home.k2.dev", username: "r", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t1" },
    hydrated: true,
  });
  useHomeServerIds.getState().reload();
  useHomesStore.getState().reload();
  __resetHomesSyncForTests({ deviceId: PHONE });
});

afterEach(() => {
  __resetHomesSyncForTests({ deviceId: PHONE });
  useHomeServerIds.setState({ bySaved: {}, hostByBox: {}, hinted: {} });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a K2 0.46.13 server (pull lists kinds)", () => {
  beforeEach(async () => {
    start(true);
    startHomesSync();
    useHomesStore.getState().ensureSeeded();
    await enableHomesSync("s1");
    A.calls.length = 0;
  });

  it("records the server's kinds", () => {
    expect(useHomesSyncStore.getState().kinds).toEqual(["home", "row", "person", "channel"]);
  });

  it("an icon, Most recent at the top, a pin and a last send reach the server; a clear goes as null", async () => {
    const s = useHomesStore.getState();
    const id = s.selectedId;
    s.addRow(id, { address: `atlas::${SRV}`, workspaceId: null, label: "Atlas" });
    s.setHomeIcon(id, "rocket");
    s.setRecentFirst(id, true);
    expect(s.pinRow(id, `atlas::${SRV}`)).toBe("pinned");
    const sentAt = Date.now();
    s.stampRowsMessaged((r) => r.address === `atlas::${SRV}`, sentAt);
    await flush(PUSH_DEBOUNCE_MS + 10);
    const home = A.items().find((i) => i.kind === "home" && i.id === id)!;
    expect(home).toMatchObject({ icon: "rocket", recentFirst: true });
    const row = A.items().find((i) => i.kind === "row" && i.address === `atlas::${SRV}`)!;
    expect(row).toMatchObject({ pinOrder: expect.any(String), lastMessagedAt: sentAt });

    A.calls.length = 0;
    s.setHomeIcon(id, null);
    s.unpinRow(id, `atlas::${SRV}`);
    await flush(PUSH_DEBOUNCE_MS + 10);
    const sent = pushedItems();
    expect(sent.find((c) => c.kind === "home")).toMatchObject({ icon: null });
    expect(sent.find((c) => c.kind === "row")).toMatchObject({ pinOrder: null });
    expect(A.items().find((i) => i.kind === "home" && i.id === id)!.icon).toBeNull();
    // Unchanged fields are left out (the server keeps them).
    expect(sent.find((c) => c.kind === "home")).not.toHaveProperty("recentFirst", false);
  });

  it("another device's group fields arrive; a later item without them keeps what the phone knows", async () => {
    const id = useHomesStore.getState().selectedId;
    A.seed([{ kind: "home", id, name: "Studio", icon: "briefcase", recentFirst: true, order: "V", updatedAt: Date.now() + 5, deviceId: "desk" }]);
    await syncHomesNow();
    expect(useHomesStore.getState().homes[0]).toMatchObject({ name: "Studio", icon: "briefcase", recentFirst: true });
    // An older desktop (or server) writes the Home again without the fields.
    A.groups = false;
    A.seed([{ kind: "home", id, name: "Studio 2", order: "V", updatedAt: Date.now() + 10, deviceId: "old" }]);
    await syncHomesNow();
    expect(useHomesStore.getState().homes[0]).toMatchObject({ name: "Studio 2", icon: "briefcase", recentFirst: true });
  });

  it("person and channel rows sync as their own kinds", async () => {
    const s = useHomesStore.getState();
    const id = s.selectedId;
    expect(s.addRow(id, { kind: "person", address: `k2:owner::${SRV}`, workspaceId: null, label: "Riley" })).toBe(true);
    expect(s.addRow(id, { kind: "channel", address: `1234::${SRV}`, workspaceId: null, label: "general" })).toBe(true);
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(A.items().filter((i) => i.kind === "person" || i.kind === "channel").map((i) => [i.kind, i.address])).toEqual([
      ["person", `k2:owner::${SRV}`],
      ["channel", `1234::${SRV}`],
    ]);
    expect(__homesSyncLocalOnly()).toEqual([]);
  });
});

describe("a K2 0.46.12 server (no kinds)", () => {
  it("keeps person / channel rows on the phone (not sent), and sends them once the server lists their kind", async () => {
    start(false);
    startHomesSync();
    const s = useHomesStore.getState();
    s.ensureSeeded();
    await enableHomesSync("s1");
    expect(useHomesSyncStore.getState().kinds).toEqual(["home", "row"]);
    A.calls.length = 0;
    const id = s.selectedId;
    s.addRow(id, { kind: "person", address: `k2:owner::${SRV}`, workspaceId: null, label: "Riley" });
    s.addRow(id, { address: `atlas::${SRV}`, workspaceId: null, label: "Atlas" });
    await flush(PUSH_DEBOUNCE_MS + 10);
    // The agent row went; the person row was held back, kept locally.
    expect(pushedItems().map((c) => c.kind)).toEqual(["row"]);
    expect(__homesSyncLocalOnly()).toEqual([`p|${id}|k2:owner::${SRV}`]);
    expect(localStorage.getItem(HOMES_LOCAL_ONLY_KEY)).toContain("k2:owner");
    expect(useHomesStore.getState().homes[0].rows.map((r) => r.address)).toContain(`k2:owner::${SRV}`);

    // A full re-pull (the server never had it) keeps it and doesn't send it.
    A.calls.length = 0;
    A.floor = 1e9;
    await syncHomesNow();
    expect(pushedItems().some((c) => c.kind === "person")).toBe(false);
    expect(useHomesStore.getState().homes[0].rows.map((r) => r.address)).toContain(`k2:owner::${SRV}`);

    // The server updates to 0.46.13: the next pull lists the kind, the row goes.
    A.floor = 0;
    A.groups = true;
    await syncHomesNow();
    await flush(PUSH_DEBOUNCE_MS + 10);
    expect(A.items().some((i) => i.kind === "person" && i.address === `k2:owner::${SRV}` && !i.deleted)).toBe(true);
    expect(__homesSyncLocalOnly()).toEqual([]);
  });

  it("an invalid_kind refusal (kinds not known yet) keeps the row local; no full re-pull for it", async () => {
    start(false);
    startHomesSync();
    const s = useHomesStore.getState();
    s.ensureSeeded();
    await enableHomesSync("s1");
    const id = s.selectedId;
    // The engine is stopped while the row is added (not queued), then the
    // outbox holds it as if it was queued before this phone read a pull.
    __resetHomesSyncForTests({ deviceId: PHONE });
    s.addRow(id, { kind: "channel", address: `42::${SRV}`, workspaceId: null, label: "general" });
    const row = useHomesStore.getState().homes[0].rows.find((r) => r.kind === "channel")!;
    const meta = JSON.parse(localStorage.getItem(HOMES_SYNC_META_KEY)!);
    localStorage.setItem(HOMES_SYNC_META_KEY, JSON.stringify({ ...meta, kinds: null }));
    localStorage.setItem(HOMES_OUTBOX_KEY, JSON.stringify({ serverId: "s1", items: [rowChange(id, row)] }));
    __resetHomesSyncForTests({ deviceId: PHONE });
    expect(useHomesSyncStore.getState().kinds).toBeNull();
    A.calls.length = 0;
    await syncHomesNow();
    expect(pushedItems().map((c) => c.kind)).toEqual(["channel"]);
    expect(useHomesStore.getState().homes[0].rows.map((r) => r.address)).toContain(`42::${SRV}`);
    expect(__homesSyncLocalOnly()).toEqual([`c|${id}|42::${SRV}`]);
    expect(useHomesSyncStore.getState().outbox).toEqual([]);
    // Not a refusal that needs the server's truth: the pull stays incremental.
    const pull = A.calls.find((c) => c.path === "/cli/me/homes")!;
    expect(pull.query.since).toBeTruthy();
    expect(useHomesSyncStore.getState().kinds).toEqual(["home", "row"]);
  });
});
