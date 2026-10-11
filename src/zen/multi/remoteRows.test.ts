// @vitest-environment jsdom
// Rows from another saved server (MS15, MS39): loaded on THAT server's
// scope with the shared row builder, keeping the last good rows on a
// failure, per-server pins / focus / hidden extras, the Q7 snapshot only
// with `daemon-activity`, and pictures (MA24) at most once a day.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getAllSessions: vi.fn(),
  getAppSettings: vi.fn(),
  getFocusGroupsList: vi.fn(),
  getActivitySnapshot: vi.fn(),
  getProjectIcon: vi.fn(),
}));
vi.mock("../../api/projectGroups", () => ({ fetchProjectGroups: vi.fn() }));

import {
  getActivitySnapshot,
  getAgentList,
  getAllSessions,
  getAppSettings,
  getCliProjectsList,
  getFocusGroupsList,
  getProjectIcon,
} from "../../api/client";
import { fetchProjectGroups } from "../../api/projectGroups";
import { __resetScopesForTests, noteBootStatus } from "../../api/scope";
import { useServersStore } from "../../stores/servers";
import { hideSidecarAddr } from "../overlayExtras";
import { rememberSidecar } from "../sidecarRows";
import {
  __resetRemoteRowsForTests,
  forgetServerRows,
  loadServerRows,
  refreshServerSnapshot,
  rowsStale,
  selectRemoteFocusGroup,
  useRemoteRows,
  ROWS_MAX_AGE_MS,
} from "./remoteRows";
import {
  __resetRemoteIconsForTests,
  ensureRemoteIcon,
  ICON_FAILURE_BACKOFF_MS,
  ICON_REFRESH_MS,
  remoteIconFor,
  useRemoteIcons,
} from "./remoteIcons";

const PROJECTS = [
  { id: "pk", name: "K2", handle: "k2", path: "/srv/k2", pinned: 1, tab_order: 0, focusGroupId: "work" },
  { id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 1, focusGroupId: "home" },
];
const AGENTS = {
  ok: true,
  agents: [
    { name: "k2", path: "/srv/k2", mode: "pod", enabled: true, live: true },
    { name: "docs", path: "/srv/docs", mode: "pod", enabled: true, live: true },
  ],
};

function okAll() {
  vi.mocked(getAgentList).mockResolvedValue({ ok: true, data: AGENTS });
  vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: PROJECTS });
  vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [{ id: "g1", name: "Team", memberCount: 2 }] } as never);
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(getAppSettings).mockResolvedValue({ ok: true, data: { focusGroupsEnabled: true, activeFocusGroupId: "work" } });
  vi.mocked(getFocusGroupsList).mockResolvedValue({
    ok: true,
    data: [
      { id: "work", name: "Work", color: null, tabOrder: 0 },
      { id: "home", name: "Home", color: null, tabOrder: 1 },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetScopesForTests();
  __resetRemoteRowsForTests();
  __resetRemoteIconsForTests();
  useServersStore.setState({
    servers: [
      { id: "sa", nickname: "Alpha", url: "https://a.k2.dev", username: "u", rememberPassword: false },
      { id: "sb", nickname: "Bravo", url: "https://b.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "sa",
    tokens: { sa: "ta", sb: "tb" },
    recovery: {},
  });
  okAll();
});

describe("loadServerRows", () => {
  it("reads B's four lists on B's scope and builds rows, pins and focus", async () => {
    await loadServerRows("sb");
    for (const fn of [getAgentList, getCliProjectsList, fetchProjectGroups, getAllSessions, getAppSettings]) {
      expect((vi.mocked(fn).mock.calls[0][0] as { id: string }).id).toBe("sb");
    }
    const rows = useRemoteRows.getState().byServer.sb;
    expect(rows.status).toBe("live");
    expect(rows.agents.map((a) => a.id)).toEqual(["group:g1", "/srv/k2", "/srv/docs"]);
    expect(rows.pinnedIds).toEqual(["/srv/k2"]);
    expect([rows.focus.enabled, rows.focus.currentId]).toEqual([true, "work"]);
    expect(rows.loadStartedAt).toBe(null);
    // The active server's slice is never written here.
    expect(useRemoteRows.getState().byServer.sa).toBeUndefined();
  });

  it("uses B's own remembered sidecars and hidden extras", async () => {
    rememberSidecar("sb", { addr: "k2/3", path: "/srv/k2", name: "k2", chatTitle: "three" });
    rememberSidecar("sa", { addr: "k2/9", path: "/srv/k2", name: "k2", chatTitle: "nine" });
    hideSidecarAddr("sb", "k2/3");
    await loadServerRows("sb");
    const rows = useRemoteRows.getState().byServer.sb;
    expect(rows.agents.map((a) => a.addr)).toContain("k2/3");
    expect(rows.agents.map((a) => a.addr)).not.toContain("k2/9");
    expect(rows.hiddenAddrs).toEqual(["k2/3"]);
  });

  it("a failure keeps the last good rows (a slow or failing server never blanks)", async () => {
    await loadServerRows("sb");
    vi.mocked(getAgentList).mockRejectedValue(new Error("Could not reach server"));
    await loadServerRows("sb");
    const rows = useRemoteRows.getState().byServer.sb;
    expect([rows.status, rows.agents.length, rows.error]).toEqual(["live", 3, "Could not reach server"]);
  });

  it("a first load that fails is an error slice", async () => {
    for (const fn of [getAgentList, getCliProjectsList, fetchProjectGroups, getAllSessions]) {
      vi.mocked(fn).mockResolvedValue({ ok: false, error: "HTTP 502" } as never);
    }
    await loadServerRows("sb");
    expect(useRemoteRows.getState().byServer.sb.status).toBe("error");
  });

  it("single-flight per server; a forget drops a late answer", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(getAgentList).mockReturnValue(new Promise((r) => (release = r)) as never);
    const p1 = loadServerRows("sb");
    const p2 = loadServerRows("sb");
    expect(p1).toBe(p2);
    expect(useRemoteRows.getState().byServer.sb.loadStartedAt).not.toBe(null);
    forgetServerRows("sb");
    release({ ok: true, data: AGENTS });
    await p1;
    expect(useRemoteRows.getState().byServer.sb).toBeUndefined();
  });

  it("stale after a minute, never while loading", async () => {
    expect(rowsStale(undefined, 0)).toBe(true);
    await loadServerRows("sb", () => 1_000);
    const rows = useRemoteRows.getState().byServer.sb;
    expect(rowsStale(rows, 1_000 + ROWS_MAX_AGE_MS - 1)).toBe(false);
    expect(rowsStale(rows, 1_000 + ROWS_MAX_AGE_MS)).toBe(true);
    expect(rowsStale({ ...rows, loadStartedAt: 5 }, 10 ** 9)).toBe(false);
  });

  it("the focus pick for B is this device's, kept per server", async () => {
    await loadServerRows("sb");
    selectRemoteFocusGroup("sb", "home");
    expect(useRemoteRows.getState().byServer.sb.focus.currentId).toBe("home");
    expect(localStorage.getItem("zen.focusGroup.sb")).toBe("home");
    expect(localStorage.getItem("zen.focusGroup.sa")).toBe(null);
    selectRemoteFocusGroup("sb", "nope");
    expect(useRemoteRows.getState().byServer.sb.focus.currentId).toBe("home");
  });
});

describe("refreshServerSnapshot (Q7)", () => {
  it("only for a server whose /boot-status lists daemon-activity", async () => {
    await refreshServerSnapshot("sb");
    expect(getActivitySnapshot).not.toHaveBeenCalled();
    noteBootStatus("sb", { version: "0.45.3", features: ["daemon-activity"] });
    vi.mocked(getActivitySnapshot).mockResolvedValue({
      ok: true,
      data: {
        rows: [
          {
            sessionId: "t1",
            agentName: "k2",
            workspacePath: "/srv/k2",
            display: "working",
            counts: { subagents: 1, tools: 2, commands: 0 },
          },
        ],
        workspaces: [],
      },
    });
    await refreshServerSnapshot("sb");
    expect((vi.mocked(getActivitySnapshot).mock.calls[0][0] as { id: string }).id).toBe("sb");
    expect(Object.keys(useRemoteRows.getState().byServer.sb.activity.bySession)).toEqual(["t1"]);
  });
});

describe("remote pictures (MA24)", () => {
  it("asks B's get-icon once a day, backs off 60 s after a failure", async () => {
    vi.mocked(getProjectIcon).mockResolvedValue({ ok: false, error: "HTTP 502" } as never);
    let now = 1_000;
    await ensureRemoteIcon("sb", "pk", "/srv/k2", () => now);
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    expect((vi.mocked(getProjectIcon).mock.calls[0][0] as { id: string }).id).toBe("sb");
    expect(vi.mocked(getProjectIcon).mock.calls[0].slice(1)).toEqual(["/srv/k2", "pk"]);
    now += ICON_FAILURE_BACKOFF_MS - 1;
    await ensureRemoteIcon("sb", "pk", "/srv/k2", () => now);
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    now += 1;
    vi.mocked(getProjectIcon).mockResolvedValue({ ok: true, data: { found: true, dataUrl: "data:image/png;base64,AA" } });
    await ensureRemoteIcon("sb", "pk", "/srv/k2", () => now);
    expect(remoteIconFor(useRemoteIcons.getState().icons, "sb", "pk")).toBe("data:image/png;base64,AA");
    now += ICON_REFRESH_MS - 1;
    await ensureRemoteIcon("sb", "pk", "/srv/k2", () => now);
    expect(getProjectIcon).toHaveBeenCalledTimes(2);
    // Not an image → no picture, and not asked again today.
    vi.mocked(getProjectIcon).mockResolvedValue({ ok: true, data: { found: true, dataUrl: "https://x/y.png" } });
    await ensureRemoteIcon("sb", "pd", "/srv/docs", () => now);
    expect(remoteIconFor(useRemoteIcons.getState().icons, "sb", "pd")).toBe(null);
    await ensureRemoteIcon("sb", "pd", "/srv/docs", () => now);
    expect(getProjectIcon).toHaveBeenCalledTimes(3);
  });

  it("no project id or path → never asked", async () => {
    await ensureRemoteIcon("sb", null, "/srv/k2");
    await ensureRemoteIcon("sb", "pk", "");
    expect(getProjectIcon).not.toHaveBeenCalled();
  });
});
