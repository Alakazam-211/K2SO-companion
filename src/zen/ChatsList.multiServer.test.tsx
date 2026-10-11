// @vitest-environment jsdom
// Multi-server S2 in the Agents list (MS15–MS20, MS35, MS38–MS40):
//   - flag off (explicit "0"; the default is now on): the list is exactly
//     today's — active server only,
//     no chips, no pool traffic, the pill opens the Servers sheet;
//   - flag on: the Agents tab is the ACTIVE server — the pill names it and
//     opens the Servers sheet (no menu); picking there switches the active
//     server and the Agents tab follows. Home reads "All" and its pill
//     opens the same sheet; switching tabs updates the pill at once;
//   - the active server signed out shows its own Sign in row. Other
//     servers' failure rows and rooms live on Home (homeMulti tests).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const net = vi.hoisted(() => ({
  /** host → boot-status body, or null for offline. */
  boot: {} as Record<string, unknown | null>,
  calls: [] as string[],
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string) => {
    net.calls.push(url);
    const u = new URL(url);
    const body = (v: unknown) => ({
      status: 200,
      ok: true,
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    if (u.pathname === "/boot-status") {
      const b = net.boot[u.host];
      if (b === null || b === undefined) throw new Error("Could not reach server: connection refused");
      return body(b);
    }
    if (u.pathname === "/cli/auth/whoami") return body({ username: "u", role: "member", mustChangePassword: false });
    if (u.pathname === "/cli/presence/summary") {
      return body({ workspaces: [], agentActivity: [{ workspaceId: "pd", status: "working", display: "waiting" }] });
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => "" };
  }),
}));

const REMOTE = vi.hoisted(() => ({
  agents: {
    ok: true,
    agents: [
      { name: "docs", path: "/srv/docs", mode: "pod", enabled: true, live: true },
      { name: "alpha", path: "/srv/alpha", mode: "pod", enabled: true, live: true },
    ],
  },
  projects: [
    { id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 },
    { id: "px", name: "alpha", handle: "alpha", path: "/srv/alpha", pinned: 0, tab_order: 1 },
  ],
}));

vi.mock("../api/client", () => {
  const remote = (scope: { id: string }) => scope.id !== "s1";
  return {
    inspectProjectsSummary: vi.fn(),
    getAgentList: vi.fn(async (scope: { id: string }) =>
      remote(scope) ? { ok: true, data: REMOTE.agents } : { ok: true, data: { ok: true, agents: [] } }
    ),
    getCliProjectsList: vi.fn(async (scope: { id: string }) =>
      remote(scope) ? { ok: true, data: REMOTE.projects } : { ok: true, data: [] }
    ),
    getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
    getProjects: vi.fn(),
    getWorkspaceResources: vi.fn(),
    getFsReadFile: vi.fn(),
    getThread: vi.fn(async () => ({ ok: true, data: { items: [] } })),
    postThread: vi.fn(),
    answerThread: vi.fn(),
    spawnSidecarSession: vi.fn(),
    uploadFsBinary: vi.fn(),
    setTabTitle: vi.fn(),
    setSessionLabel: vi.fn(),
    setProjectPinned: vi.fn(async () => ({ ok: true, data: {} })),
    reorderProjects: vi.fn(async () => ({ ok: true, data: {} })),
    assignFocusGroup: vi.fn(),
    createFocusGroup: vi.fn(),
    getAppSettings: vi.fn(async () => ({ ok: true, data: {} })),
    getFocusGroupsList: vi.fn(async () => ({ ok: true, data: [] })),
    getActivitySnapshot: vi.fn(async () => ({ ok: true, data: { rows: [], workspaces: [] } })),
    getProjectIcon: vi.fn(async () => ({ ok: true, data: { found: false } })),
    createWorkspace: vi.fn(),
    getFsInfo: vi.fn(async () => ({ ok: true, data: { home: "/Users/r" } })),
    updateProjectLook: vi.fn(),
    ensurePinnedChat: vi.fn(),
  };
});

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(async () => "still-valid"),
  isPossibleAuthFailure: (status: number, body: string) =>
    status === 401 || (status === 403 && /invalid or missing (?:auth )?token/i.test(body)),
  revive: vi.fn(async () => "still-valid"),
}));

import { connectServer } from "../lib/revive";
import { __resetScopesForTests } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { FOCUS_OFF } from "./serverPins";
import { useZenStore } from "./zenStore";
import { pool } from "./multi/pool";
import { __resetRemoteRowsForTests, useRemoteRows } from "./multi/remoteRows";
import { __resetRemoteIconsForTests } from "./multi/remoteIcons";
import { MULTI_SERVER_KEY, useMultiServerPrefs } from "./multi/prefs";

const READY = { version: "0.45.3", protocol: 1, phase: "ready", instanceId: "i1", features: [] };

const S1 = { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "u", rememberPassword: false };
const S2 = { id: "s2", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };

const LA = { id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" as const };
const LB = { id: "/b", name: "bravo-ws", initial: "B", path: "/b", addr: "bravo", kind: "agent" as const };

function seed(servers = [S1, S2], tokens: Record<string, string> = { s1: "t1", s2: "t2" }) {
  useServersStore.setState({
    servers,
    activeServerId: "s1",
    hydrated: true,
    tokens,
    recovery: { s1: "connected" },
  });
  useZenStore.setState({
    agentSource: "live",
    agents: [LA, LB],
    agentError: null,
    screen: "list",
    pinnedIds: [],
    hiddenSidecarAddrs: [],
    serverProjects: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    pinError: null,
  });
}

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

function setFlag(on: boolean) {
  act(() => useMultiServerPrefs.getState().setMultiServer(on));
}

beforeEach(() => {
  localStorage.clear();
  net.calls = [];
  net.boot = { "home.k2.dev": READY, "bravo.k2.dev": READY, "charlie.k2.dev": READY };
  __resetScopesForTests();
  __resetRemoteRowsForTests();
  __resetRemoteIconsForTests();
  for (const id of ["s1", "s2", "s3"]) pool.forget(id);
  useMultiServerPrefs.setState({ multiServer: false });
  vi.mocked(connectServer).mockClear();
});

afterEach(() => {
  cleanup();
});

const rowNames = () => screen.queryAllByTestId("row-name").map((n) => n.textContent);

describe("flag off (explicit): today's list, unchanged", () => {
  it("an explicit off never touches other servers", async () => {
    setFlag(false);
    expect(useMultiServerPrefs.getState().multiServer).toBe(false);
    expect(localStorage.getItem(MULTI_SERVER_KEY)).toBe("0");
    seed();
    mount();
    expect(rowNames()).toEqual(["alpha", "bravo-ws"]);
    expect(screen.queryAllByTestId("row-server-chip")).toHaveLength(0);
    expect(screen.queryAllByTestId("remote-row")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
    // No pool: no /boot-status, nothing sent to server B (the active
    // server's own identity read is today's).
    await new Promise((r) => setTimeout(r, 20));
    expect(net.calls.filter((u) => u.includes("/boot-status"))).toEqual([]);
    expect(net.calls.every((u) => u.startsWith("https://home.k2.dev/"))).toBe(true);
    expect(useRemoteRows.getState().byServer).toEqual({});
    // The pill is the active server's nickname and opens the Servers sheet.
    const pill = screen.getByTestId("chats-header-server");
    expect(pill.getAttribute("aria-label")).toBe("Server Home");
    fireEvent.click(pill);
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.queryByTestId("server-filter-menu")).toBeNull();
    expect(screen.queryByTestId("servers-pinned-label")).toBeNull();
  });
});

/** Pick a server in the Servers sheet (the pill opens it). */
async function pickInServers(label: string) {
  fireEvent.click(screen.getByTestId("chats-header-server"));
  const sheet = screen.getByTestId("overlay-servers");
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: label }));
  });
}

describe("flag on: the pill opens the Servers sheet; Agents is the active server", () => {
  it("defaults to the active server: its name on the pill, its rows only, no chips", async () => {
    seed();
    setFlag(true);
    mount();
    // B is still read (Home and the Servers sheet's dots use it)…
    await waitFor(() => expect(useRemoteRows.getState().byServer.s2?.status).toBe("live"));
    // …but the Agents tab lists the active server's rows only.
    expect(rowNames()).toEqual(["alpha", "bravo-ws"]);
    expect(screen.queryAllByTestId("remote-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("row-server-chip")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
    expect(screen.getByTestId("server-name").textContent).toBe("Home");
    expect(screen.getByTestId("chats-header-server").getAttribute("aria-label")).toBe("Server Home");
  });

  it("tapping the pill on Agents opens the Servers sheet directly; no menu renders", async () => {
    seed();
    setFlag(true);
    mount();
    const pill = screen.getByTestId("chats-header-server");
    expect(pill.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(pill);
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.queryByTestId("server-filter-menu")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    // MS38: the pinned card names the default server's job.
    expect(screen.getByTestId("servers-pinned-label").textContent).toBe(
      "Default server (Tickets, classic view)"
    );
  });

  it("picking a server in Servers switches the active server and the Agents tab follows", async () => {
    seed();
    setFlag(true);
    const hydrate = vi.fn(async () => {
      useZenStore.setState({
        agents: [{ id: "/srv/docs", name: "docs", initial: "D", path: "/srv/docs", addr: "docs", kind: "agent" }],
      });
    });
    useZenStore.setState({ hydrateAgents: hydrate });
    mount();
    await pickInServers("Bravo");
    await waitFor(() => expect(useServersStore.getState().activeServerId).toBe("s2"));
    expect(connectServer).toHaveBeenCalledWith("s2");
    await waitFor(() => expect(hydrate).toHaveBeenCalled());
    // The Agents tab is now Bravo: pill and rows (its own rows, not remote ones).
    expect(screen.getByTestId("server-name").textContent).toBe("Bravo");
    expect(screen.getByTestId("chats-header-server").getAttribute("aria-label")).toBe("Server Bravo");
    await waitFor(() => expect(rowNames()).toEqual(["docs"]));
    expect(screen.queryAllByTestId("remote-row")).toHaveLength(0);
    // Nothing separate is remembered: a remount still shows the active server.
    expect(localStorage.getItem("zen.serverFilter")).toBeNull();
    cleanup();
    mount();
    expect(screen.getByTestId("server-name").textContent).toBe("Bravo");
  });

  it("a leftover zen.serverFilter pick is ignored: the Agents tab is the active server", async () => {
    localStorage.setItem("zen.serverFilter", "s2");
    seed();
    setFlag(true);
    mount();
    expect(screen.getByTestId("server-name").textContent).toBe("Home");
    expect(rowNames()).toEqual(["alpha", "bravo-ws"]);
    expect(screen.queryAllByTestId("remote-row")).toHaveLength(0);
  });

  it("the active server's pins stay draggable ones (not remote pins)", async () => {
    seed();
    useZenStore.setState({
      serverProjects: [
        { id: "pa", name: "alpha", path: "/a", handle: "alpha", pinned: true, tabOrder: 0, focusGroupId: null },
      ],
      pinnedIds: ["/a"],
    });
    setFlag(true);
    mount();
    const grid = within(screen.getByTestId("chats-pins"));
    expect(grid.getByLabelText(/^Pinned alpha/)).not.toBeNull();
    expect(screen.queryAllByTestId("remote-pin")).toHaveLength(0);
  });

  it("one saved server: its name on the pill; the title is today's", async () => {
    seed([S1], { s1: "t1" });
    setFlag(true);
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryAllByTestId("row-server-chip")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
    expect(screen.getByTestId("server-name").textContent).toBe("Home");
  });

  it("search runs on the active server only", async () => {
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(useRemoteRows.getState().byServer.s2?.status).toBe("live"));
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "alpha" } });
    expect(rowNames()).toEqual(["alpha"]);
    expect(screen.queryAllByTestId("remote-row")).toHaveLength(0);
    // The server's name is not a search term.
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "bravo" } });
    expect(rowNames()).toEqual(["bravo-ws"]);
  });

  it("Home reads All and its pill opens the same Servers sheet; switching tabs updates the pill", async () => {
    seed();
    setFlag(true);
    mount();
    expect(screen.getByTestId("server-name").textContent).toBe("Home");
    fireEvent.click(screen.getByTestId("list-tab-home"));
    expect(screen.getByTestId("server-name").textContent).toBe("All");
    expect(screen.getByTestId("chats-header-server").getAttribute("aria-label")).toBe("Servers: All");
    fireEvent.click(screen.getByTestId("chats-header-server"));
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.queryByTestId("server-filter-menu")).toBeNull();
    // Still on Home: the sheet does not jump tabs.
    expect(screen.getByTestId("list-tab-home").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(screen.getByTestId("server-name").textContent).toBe("Home");
  });
});

describe("failure rows on the Agents tab", () => {
  it("the active server signed out shows its own Sign in row instead of stub rows", async () => {
    seed();
    useZenStore.setState({ agentSource: "stub" });
    setFlag(true);
    mount();
    const row = screen.getAllByTestId("server-placeholder-row").find((r) => r.getAttribute("data-server-id") === "s1")!;
    expect(within(row).getByTestId("row-failure").textContent).toBe("Sign in to Home");
    expect(screen.queryByText("STUB")).toBeNull();
  });
});
