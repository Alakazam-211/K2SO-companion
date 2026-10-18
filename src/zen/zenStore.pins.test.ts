// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MA21: Zen's server is a fake scope (`zen()`), not mocked globals.
vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

vi.mock("../api/client", () => ({
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getActivitySnapshot: vi.fn(async () => ({ ok: false, status: 404 })),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  postThread: vi.fn(),
  answerThread: vi.fn(),
  spawnSidecarSession: vi.fn(),
  setTabTitle: vi.fn(),
  setSessionLabel: vi.fn(),
  setProjectPinned: vi.fn(),
  reorderProjects: vi.fn(),
  getAppSettings: vi.fn(),
  getFocusGroupsList: vi.fn(),
  assignFocusGroup: vi.fn(),
  createFocusGroup: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(),
  postProjectGroupMessage: vi.fn(),
}));

import * as client from "../api/client";
import {
  assignFocusGroup,
  createFocusGroup,
  getAgentList,
  getAppSettings,
  getCliProjectsList,
  getFocusGroupsList,
  reorderProjects,
  setProjectPinned,
} from "../api/client";
import { LEGACY_PIN_STORAGE_KEY } from "./pinChats";
import { FOCUS_OFF, focusGroupStorageKey } from "./serverPins";
import { PIN_ERROR_MS, useZenStore } from "./zenStore";
import { fakeScope } from "../test/fakeScope";
import { setZenScope, zen } from "../test/zenScopeMock";

// A fresh fake server per test (was: getActiveServer / getToken mocks).
beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "u" }));
});


const AGENTS = {
  ok: true,
  data: {
    ok: true,
    agents: [
      { name: "alpha", path: "/a" },
      { name: "bravo", path: "/b" },
      { name: "charlie", path: "/c" },
    ],
  },
};

function projects(over: Record<string, Record<string, unknown>> = {}) {
  const rows = [
    { id: "pa", name: "alpha", handle: "alpha", path: "/a", pinned: 0, tabOrder: 0, focusGroupId: null },
    { id: "pb", name: "bravo", handle: "bravo", path: "/b", pinned: 1, tabOrder: 5, focusGroupId: "g1" },
    { id: "pc", name: "charlie", handle: "charlie", path: "/c", pinned: 1, tabOrder: 2, focusGroupId: "g2" },
    { id: "pa1", name: "alpha 1", handle: "alpha/1", path: "/a", pinned: 0, tabOrder: 9, focusGroupId: null },
  ];
  return { ok: true, data: rows.map((r) => ({ ...r, ...(over[r.id] ?? {}) })) };
}

const GROUPS = {
  ok: true,
  data: [
    { id: "g2", name: "Play", color: null, tabOrder: 1, createdAt: 0 },
    { id: "g1", name: "Work", color: "#ff0000", tabOrder: 0, createdAt: 0 },
  ],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function hydrate() {
  await useZenStore.getState().hydrateAgents();
  // refreshFocus is fired from hydrate; let it settle.
  await vi.waitFor(() => expect(getAppSettings).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
  zen().setId("s1"); zen().setUsername("u");
  vi.mocked(getAgentList).mockResolvedValue(AGENTS as never);
  vi.mocked(getCliProjectsList).mockReset();
  vi.mocked(getCliProjectsList).mockResolvedValue(projects() as never);
  vi.mocked(setProjectPinned).mockReset();
  vi.mocked(setProjectPinned).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(reorderProjects).mockReset();
  vi.mocked(reorderProjects).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(getAppSettings).mockReset();
  vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: false } });
  vi.mocked(getFocusGroupsList).mockReset();
  vi.mocked(getFocusGroupsList).mockResolvedValue(GROUPS as never);
  vi.mocked(assignFocusGroup).mockReset();
  vi.mocked(assignFocusGroup).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(createFocusGroup).mockReset();
  useZenStore.setState({
    focusGroupsEnabled: false,
    agentSource: "stub",
    agents: [],
    serverProjects: [],
    pinnedIds: [],
    pinError: null,
    focus: FOCUS_OFF,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("server pins", () => {
  it("pinnedIds come from the server: pinned workspaces' main rows in tabOrder", async () => {
    await hydrate();
    const s = useZenStore.getState();
    // charlie (tabOrder 2) before bravo (5); alpha unpinned.
    expect(s.pinnedIds).toEqual(["/c", "/b"]);
    expect(s.serverProjects.find((p) => p.id === "pb")?.pinned).toBe(true);
  });

  it("the old per-device pin key is cleared at start and never written", async () => {
    localStorage.setItem(LEGACY_PIN_STORAGE_KEY, JSON.stringify(["/a"]));
    vi.resetModules();
    await import("./zenStore");
    expect(localStorage.getItem(LEGACY_PIN_STORAGE_KEY)).toBeNull();
    await hydrate();
    await useZenStore.getState().pinChat("/a");
    expect(localStorage.getItem(LEGACY_PIN_STORAGE_KEY)).toBeNull();
    // The old list did not migrate: /a only pinned by the write above.
    expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", true);
  });

  it("pin calls projects/update with the projectId and 1, optimistically", async () => {
    await hydrate();
    const gate = deferred<{ ok: boolean; data: unknown }>();
    vi.mocked(setProjectPinned).mockReturnValue(gate.promise as never);
    const done = useZenStore.getState().pinChat("/a");
    expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", true);
    // Optimistic: alpha (tabOrder 0) is in the grid before the server answers.
    expect(useZenStore.getState().pinnedIds).toEqual(["/a", "/c", "/b"]);
    gate.resolve({ ok: true, data: {} });
    await done;
    expect(reorderProjects).not.toHaveBeenCalled();
    // Refetch after the write.
    expect(getCliProjectsList).toHaveBeenCalledTimes(2);
  });

  it("unpin calls projects/update with 0", async () => {
    await hydrate();
    await useZenStore.getState().unpinChat("/b");
    expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pb", false);
  });

  it("a failed pin rolls back, shows a short error, then refetches", async () => {
    await hydrate();
    vi.useFakeTimers();
    vi.mocked(setProjectPinned).mockResolvedValue({ ok: false, error: "nope", status: 500 });
    await useZenStore.getState().unpinChat("/c");
    const s = useZenStore.getState();
    expect(s.pinnedIds).toEqual(["/c", "/b"]);
    expect(s.pinError).toBe("nope");
    expect(getCliProjectsList).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PIN_ERROR_MS);
    expect(useZenStore.getState().pinError).toBeNull();
  });

  it("reorder sends only the pinned ids, in the new order", async () => {
    await hydrate();
    const done = useZenStore.getState().movePin("/b", "/c");
    expect(reorderProjects).toHaveBeenCalledWith(expect.anything(), ["pb", "pc"]);
    expect(useZenStore.getState().pinnedIds).toEqual(["/b", "/c"]);
    await done;
    expect(setProjectPinned).not.toHaveBeenCalled();
  });

  it("a failed reorder puts the old order back", async () => {
    await hydrate();
    vi.mocked(reorderProjects).mockResolvedValue({ ok: false, error: "busy" });
    await useZenStore.getState().movePin("/b", "/c");
    expect(useZenStore.getState().pinnedIds).toEqual(["/c", "/b"]);
    expect(useZenStore.getState().pinError).toBe("busy");
  });

  it("Rearrange: reorderRows sends the FULL order; the shown rows swap slots, pins and the rest stay", async () => {
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pb: { pinned: 0 } }) as never);
    await hydrate();
    // Server order: pa (0), pc (2, pinned), pb (5), pa1 (9).
    const done = useZenStore.getState().reorderRows(["/b", "/a"]);
    expect(reorderProjects).toHaveBeenCalledWith(expect.anything(), ["pb", "pc", "pa", "pa1"]);
    // Optimistic: tab_order = index before the server answers.
    const order = Object.fromEntries(useZenStore.getState().serverProjects.map((p) => [p.id, p.tabOrder]));
    expect(order).toEqual({ pb: 0, pc: 1, pa: 2, pa1: 3 });
    expect(useZenStore.getState().pinnedIds).toEqual(["/c"]);
    await done;
    expect(setProjectPinned).not.toHaveBeenCalled();
  });

  it("Rearrange: an unchanged order, one row, or rows with no workspace write nothing", async () => {
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pb: { pinned: 0 } }) as never);
    await hydrate();
    await useZenStore.getState().reorderRows(["/a", "/b"]);
    await useZenStore.getState().reorderRows(["/a"]);
    await useZenStore.getState().reorderRows(["group:x", "/nowhere"]);
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("Rearrange: a failed reorder puts the old order back with the short error", async () => {
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pb: { pinned: 0 } }) as never);
    await hydrate();
    vi.mocked(reorderProjects).mockResolvedValue({ ok: false, error: "busy" });
    await useZenStore.getState().reorderRows(["/b", "/a"]);
    const order = Object.fromEntries(useZenStore.getState().serverProjects.map((p) => [p.id, p.tabOrder]));
    expect(order).toEqual({ pa: 0, pb: 5, pc: 2, pa1: 9 });
    expect(useZenStore.getState().pinError).toBe("busy");
  });

  it("a hold-drag drop at a spot pins, then reorders the pinned ids", async () => {
    await hydrate();
    const done = useZenStore.getState().pinChat("/a", "/b");
    expect(useZenStore.getState().pinnedIds).toEqual(["/c", "/a", "/b"]);
    await done;
    expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", true);
    expect(reorderProjects).toHaveBeenCalledWith(expect.anything(), ["pc", "pa", "pb"]);
  });

  it("sidecar and project-group rows cannot pin", async () => {
    await hydrate();
    useZenStore.setState({
      agents: [
        ...useZenStore.getState().agents,
        { id: "/a::alpha/1", name: "alpha", initial: "A", path: "/a", addr: "alpha/1" },
        { id: "group:x", name: "Grp", initial: "G", kind: "group", groupId: "x" },
      ],
    });
    await useZenStore.getState().pinChat("/a::alpha/1");
    await useZenStore.getState().pinChat("group:x");
    expect(setProjectPinned).not.toHaveBeenCalled();
  });

  it("refreshPins picks up a pin made on the desktop", async () => {
    await hydrate();
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pa: { pinned: 1 } }) as never);
    await useZenStore.getState().refreshPins();
    expect(useZenStore.getState().pinnedIds).toEqual(["/a", "/c", "/b"]);
  });
});

describe("focus groups", () => {
  it("groups off: Agents, no group list read", async () => {
    await hydrate();
    expect(useZenStore.getState().focus).toEqual(FOCUS_OFF);
    expect(getFocusGroupsList).not.toHaveBeenCalled();
  });

  it("only a literal true turns groups on", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: "true" } });
    await hydrate();
    expect(useZenStore.getState().focus.enabled).toBe(false);
  });

  it("seeds the current group from the server's activeFocusGroupId", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ok: true,
      data: { focusGroupsEnabled: true, activeFocusGroupId: "g2" },
    });
    await hydrate();
    const f = useZenStore.getState().focus;
    expect(f.enabled).toBe(true);
    expect(f.currentId).toBe("g2");
    // Groups in tabOrder.
    expect(f.groups.map((g) => g.name)).toEqual(["Work", "Play"]);
    expect(localStorage.getItem(focusGroupStorageKey("s1"))).toBe("g2");
  });

  it("missing server value seeds the first group by tabOrder", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: true } });
    await hydrate();
    expect(useZenStore.getState().focus.currentId).toBe("g1");
  });

  it("the device's own pick persists per server and wins over the server value", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ok: true,
      data: { focusGroupsEnabled: true, activeFocusGroupId: "g1" },
    });
    await hydrate();
    useZenStore.getState().selectFocusGroup("g2");
    expect(useZenStore.getState().focus.currentId).toBe("g2");
    expect(localStorage.getItem(focusGroupStorageKey("s1"))).toBe("g2");
    await useZenStore.getState().refreshFocus();
    expect(useZenStore.getState().focus.currentId).toBe("g2");
  });

  it("switching never writes the server (no settings/update)", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: true } });
    await hydrate();
    useZenStore.getState().selectFocusGroup("g2");
    expect(setProjectPinned).not.toHaveBeenCalled();
    expect(reorderProjects).not.toHaveBeenCalled();
    const real = await vi.importActual<typeof client>("../api/client");
    expect(Object.keys(real).filter((k) => /settings/i.test(k) && !k.startsWith("get"))).toEqual([]);
  });

  it("a deleted stored group falls back to the server value, then the first group", async () => {
    localStorage.setItem(focusGroupStorageKey("s1"), "gone");
    vi.mocked(getAppSettings).mockResolvedValue({
      ok: true,
      data: { focusGroupsEnabled: true, activeFocusGroupId: "g2" },
    });
    await hydrate();
    expect(useZenStore.getState().focus.currentId).toBe("g2");

    localStorage.setItem(focusGroupStorageKey("s1"), "gone");
    vi.mocked(getAppSettings).mockResolvedValue({
      ok: true,
      data: { focusGroupsEnabled: true, activeFocusGroupId: "also-gone" },
    });
    await useZenStore.getState().refreshFocus();
    expect(useZenStore.getState().focus.currentId).toBe("g1");
  });

  it("older server: settings/get 404 or focus-groups/list 404 means groups off", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({ ok: false, status: 404, error: "route not found" });
    await hydrate();
    expect(useZenStore.getState().focus).toEqual(FOCUS_OFF);

    vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: true } });
    vi.mocked(getFocusGroupsList).mockResolvedValue({ ok: false, status: 404, error: "route not found" });
    await useZenStore.getState().refreshFocus();
    expect(useZenStore.getState().focus).toEqual(FOCUS_OFF);
  });

  it("settings without the fields (pre-focus-group daemon) means groups off", async () => {
    vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { theme: "dark" } });
    await hydrate();
    expect(useZenStore.getState().focus).toEqual(FOCUS_OFF);
    expect(getFocusGroupsList).not.toHaveBeenCalled();
  });
});

describe("focus group membership writes", () => {
  const groupOf = (pid: string) =>
    useZenStore.getState().serverProjects.find((p) => p.id === pid)?.focusGroupId ?? null;
  const groupsOn = () =>
    vi.mocked(getAppSettings).mockResolvedValue({
      ok: true,
      data: { focusGroupsEnabled: true, activeFocusGroupId: "g1" },
    });

  it("enabled with no groups yet: groups count as on, the view stays unfiltered", async () => {
    groupsOn();
    vi.mocked(getFocusGroupsList).mockResolvedValue({ ok: true, data: [] });
    await hydrate();
    expect(useZenStore.getState().focusGroupsEnabled).toBe(true);
    expect(useZenStore.getState().focus).toEqual(FOCUS_OFF);
  });

  it("assign posts the row's projectId, moves it at once, then re-reads projects and groups", async () => {
    groupsOn();
    await hydrate();
    vi.mocked(getCliProjectsList).mockClear();
    vi.mocked(getFocusGroupsList).mockClear();
    const hold = deferred<{ ok: boolean; data: unknown }>();
    vi.mocked(assignFocusGroup).mockReturnValue(hold.promise as never);
    const done = useZenStore.getState().assignFocusGroup("/a", "g2");
    expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pa", "g2");
    expect(groupOf("pa")).toBe("g2");
    hold.resolve({ ok: true, data: {} });
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pa: { focusGroupId: "g2" } }) as never);
    expect(await done).toBe(true);
    await vi.waitFor(() => expect(getFocusGroupsList).toHaveBeenCalled());
    expect(getCliProjectsList).toHaveBeenCalled();
    expect(groupOf("pa")).toBe("g2");
  });

  it("null ungroups", async () => {
    groupsOn();
    await hydrate();
    await useZenStore.getState().assignFocusGroup("/b", null);
    expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pb", null);
  });

  it("a failed assign rolls back with a short error", async () => {
    groupsOn();
    await hydrate();
    vi.mocked(assignFocusGroup).mockResolvedValue({ ok: false, error: "Member role required" });
    expect(await useZenStore.getState().assignFocusGroup("/b", "g2")).toBe(false);
    expect(groupOf("pb")).toBe("g1");
    expect(useZenStore.getState().pinError).toBe("Member role required");
  });

  it("groups off, or a row that is not a workspace: no write", async () => {
    await hydrate();
    expect(await useZenStore.getState().assignFocusGroup("/a", "g1")).toBe(false);
    groupsOn();
    await useZenStore.getState().refreshFocus();
    useZenStore.setState({
      agents: [
        ...useZenStore.getState().agents,
        { id: "/a::alpha/1", name: "alpha", initial: "A", path: "/a", addr: "alpha/1" } as never,
      ],
    });
    expect(await useZenStore.getState().assignFocusGroup("/a::alpha/1", "g1")).toBe(false);
    expect(assignFocusGroup).not.toHaveBeenCalled();
  });

  it("create then assign: the first group turns the view on", async () => {
    groupsOn();
    vi.mocked(getFocusGroupsList).mockResolvedValue({ ok: true, data: [] });
    await hydrate();
    const g = { id: "g9", name: "Ops", color: null, tabOrder: 0, createdAt: 0 };
    vi.mocked(createFocusGroup).mockResolvedValue({ ok: true, data: g });
    vi.mocked(getFocusGroupsList).mockResolvedValue({ ok: true, data: [g] });
    vi.mocked(getCliProjectsList).mockResolvedValue(projects({ pa: { focusGroupId: "g9" } }) as never);
    expect(await useZenStore.getState().createFocusGroupFor("/a", " Ops ")).toBe(true);
    expect(createFocusGroup).toHaveBeenCalledWith(expect.anything(), "Ops");
    expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pa", "g9");
    expect(groupOf("pa")).toBe("g9");
    const f = useZenStore.getState().focus;
    expect(f.enabled).toBe(true);
    expect(f.groups.map((x) => x.id)).toEqual(["g9"]);
  });

  it("a failed create assigns nothing", async () => {
    groupsOn();
    await hydrate();
    vi.mocked(createFocusGroup).mockResolvedValue({ ok: false, error: "Could not create group" });
    expect(await useZenStore.getState().createFocusGroupFor("/a", "Ops")).toBe(false);
    expect(assignFocusGroup).not.toHaveBeenCalled();
    expect(useZenStore.getState().pinError).toBe("Could not create group");
  });
});
