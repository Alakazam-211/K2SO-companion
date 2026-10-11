// @vitest-environment jsdom
// Multi-server S2 in the Agents list (MS15–MS20, MS35, MS38–MS40):
//   - flag off (explicit "0"; the default is now on): the list is exactly
//     today's — active server only,
//     no chips, no pool traffic, the pill opens the Servers sheet;
//   - flag on: two mocked servers merge into one list with server chips,
//     "All servers" title, the pill is a server filter;
//   - failure rows are greyed with one action each, scoped to their server;
//     Sign in opens that server's sheet without switching;
//   - S3: opening a row from another server opens a ROOM there (the active
//     server never changes); below the floor it switches the old way.
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
import { getAgentList, getCliProjectsList } from "../api/client";
import { roomServerId } from "./zenScope";
import { roomBelowFloor } from "./multi/useMultiServerList";
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
const S3 = { id: "s3", nickname: "Charlie", url: "https://charlie.k2.dev", username: "u", rememberPassword: false };

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
  useMultiServerPrefs.setState({ multiServer: false, serverFilter: "all" });
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

describe("flag on: one merged list over two servers", () => {
  it("renders both servers' rows with chips, 'All servers' title and the filter pill", async () => {
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("remote-row")).toHaveLength(2));
    expect(rowNames().sort()).toEqual(["alpha", "alpha", "bravo-ws", "docs"].sort());
    // Same handle on two servers = two rows; each carries its server chip.
    const chips = screen.getAllByTestId("row-server-chip").map((c) => c.textContent);
    expect(chips.filter((c) => c === "Home")).toHaveLength(2);
    expect(chips.filter((c) => c === "Bravo")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "All servers" })).not.toBeNull();
    expect(screen.getByTestId("server-name").textContent).toBe("All");
    // B's rows were read on B's scope; the active list is untouched.
    expect(useRemoteRows.getState().byServer.s2.status).toBe("live");
    expect(useRemoteRows.getState().byServer.s1).toBeUndefined();
    // B's summary says docs is waiting: dot + word, no counts (MA12).
    const docs = screen.getAllByTestId("remote-row").find((r) => r.textContent?.includes("docs"))!;
    expect(within(docs).getByTestId("row-activity").textContent).toBe("Needs you");
  });

  it("the pin grid shows pins from both servers, each with its server (MS19, R2)", async () => {
    REMOTE.projects[0].pinned = 1;
    const original = vi.mocked(getCliProjectsList).getMockImplementation()!;
    vi.mocked(getCliProjectsList).mockImplementation(async (scope) =>
      scope.id === "s1"
        ? { ok: true, data: [{ id: "pa", name: "alpha", handle: "alpha", path: "/a", pinned: 1, tab_order: 0 }] }
        : original(scope)
    );
    try {
      seed();
      useZenStore.setState({
        serverProjects: [
          { id: "pa", name: "alpha", path: "/a", handle: "alpha", pinned: true, tabOrder: 0, focusGroupId: null },
        ],
        pinnedIds: ["/a"],
      });
      setFlag(true);
      mount();
      await waitFor(() => expect(screen.getAllByTestId("remote-pin")).toHaveLength(1));
      const grid = within(screen.getByTestId("chats-pins"));
      expect(grid.getByLabelText(/^Pinned alpha/)).not.toBeNull();
      const remotePin = screen.getByTestId("remote-pin");
      expect(remotePin.getAttribute("aria-label")).toMatch(/^Pinned docs, Bravo/);
      expect(within(remotePin).getByTestId("pin-server").textContent).toBe("Bravo");
      // A pinned row shows once: not again in the list.
      expect(screen.getAllByTestId("remote-row").map((r) => r.textContent)).not.toContain(
        expect.stringContaining("docs")
      );
    } finally {
      REMOTE.projects[0].pinned = 0;
      vi.mocked(getCliProjectsList).mockImplementation(original);
    }
  });

  it("one saved server: no chips; the title is today's", async () => {
    seed([S1], { s1: "t1" });
    setFlag(true);
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryAllByTestId("row-server-chip")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
  });

  it("search runs across servers and matches the chip", async () => {
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("remote-row")).toHaveLength(2));
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "bravo" } });
    // "bravo-ws" on Home by name, both B rows by chip.
    expect(rowNames().sort()).toEqual(["alpha", "bravo-ws", "docs"].sort());
  });

  it("the pill filters by server and offers Manage servers…", async () => {
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("remote-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("chats-header-server"));
    const menu = screen.getByTestId("server-filter-menu");
    expect(within(menu).getByTestId("server-filter-all").getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getAllByTestId("server-filter-dot")).toHaveLength(2);
    fireEvent.click(within(menu).getByTestId("server-filter-s2"));
    expect(rowNames().sort()).toEqual(["alpha", "docs"]);
    expect(screen.getByTestId("server-name").textContent).toBe("Bravo");
    expect(localStorage.getItem("zen.serverFilter")).toBe("s2");
    fireEvent.click(screen.getByTestId("chats-header-server"));
    fireEvent.click(screen.getByTestId("server-filter-manage"));
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    // MS38: the pinned card names the default server's job.
    expect(screen.getByTestId("servers-pinned-label").textContent).toBe(
      "Default server (Tickets, classic view)"
    );
  });

  it("S3 (MS21): opening a row from server B opens a room on B; the active server never changes", async () => {
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("remote-row")).toHaveLength(2));
    vi.mocked(getAgentList).mockClear();
    const docs = screen.getAllByTestId("remote-row").find((r) => r.textContent?.includes("docs"))!;
    fireEvent.click(within(docs).getByRole("button"));
    await waitFor(() => expect(useZenStore.getState().agentId).toBe("/srv/docs"));
    await waitFor(() => expect(useZenStore.getState().agentSource).toBe("live"));
    expect(useServersStore.getState().activeServerId).toBe("s1");
    expect(roomServerId()).toBe("s2");
    expect(connectServer).not.toHaveBeenCalled();
    // The room's rows are read on B's scope only.
    expect(vi.mocked(getAgentList).mock.calls.map(([sc]) => (sc as { id: string }).id)).toEqual(["s2"]);
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useZenStore.getState().threadAddr).toBe("docs");
    // Back: the active server's list comes back as it was, still s1.
    act(() => useZenStore.getState().closeChat());
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().agents.map((a) => a.id)).toEqual(["/a", "/b"]);
    expect(useServersStore.getState().activeServerId).toBe("s1");
  });

  it("MS30 / Q9 floor: a server known to be below 0.41.6 opens the old way (switch)", async () => {
    net.boot["bravo.k2.dev"] = { ...READY, version: "0.41.5" };
    seed();
    setFlag(true);
    // B's rows are cached from before it was found too old.
    useRemoteRows.setState({
      byServer: {
        s2: {
          ...(await import("./multi/remoteRows")).emptyRemoteRows(),
          status: "live",
          agents: [{ id: "/srv/docs", name: "docs", initial: "D", path: "/srv/docs", addr: "docs", kind: "agent" }],
          loadedAt: Date.now(),
        },
      },
    });
    const hydrate = vi.fn(async (_opts?: { resumeId?: string }) => {});
    useZenStore.setState({ hydrateAgents: hydrate });
    mount();
    await waitFor(() => expect(pool.entry("s2")?.boot?.version).toBe("0.41.5"));
    const row = await waitFor(() => {
      const r = screen.getAllByTestId("remote-row").find((x) => x.textContent?.includes("docs"));
      expect(r).toBeTruthy();
      return r!;
    });
    expect(row.textContent).toContain("Bravo needs an update");
    expect(roomBelowFloor("s2")).toBe(true);
    // Its one action is "Open": the old way, never a room.
    fireEvent.click(within(row).getByRole("button", { name: /Open the old way/ }));
    await waitFor(() => expect(useServersStore.getState().activeServerId).toBe("s2"));
    expect(roomServerId()).toBeNull();
    expect(connectServer).toHaveBeenCalledWith("s2");
    expect(hydrate).toHaveBeenCalled();
  });
});

describe("failure rows: greyed, one action each, scoped to their server", () => {
  it("offline, signed-out and unchecked servers each show their state and one fix", async () => {
    net.boot["bravo.k2.dev"] = null; // offline
    seed([S1, S2, S3], { s1: "t1", s2: "t2" }); // s3: no login
    // B had rows before it went away: they stay, greyed.
    useRemoteRows.setState({
      byServer: {
        s2: {
          ...(await import("./multi/remoteRows")).emptyRemoteRows(),
          status: "live",
          agents: [{ id: "/srv/docs", name: "docs", initial: "D", path: "/srv/docs", addr: "docs", kind: "agent" }],
          loadedAt: 1,
        },
      },
    });
    setFlag(true);
    mount();
    await waitFor(() =>
      expect(screen.getAllByTestId("row-failure").map((f) => f.getAttribute("data-state")).sort()).toEqual([
        "offline",
        "signin-required",
      ])
    );
    const offline = screen.getAllByTestId("remote-row").find((r) => r.getAttribute("data-server-id") === "s2")!;
    expect(offline.getAttribute("data-greyed")).toBe("1");
    expect(within(offline).getByTestId("row-failure").textContent).toMatch(/^Offline · retrying in \d+ s$/);
    const offActions = within(offline).getAllByTestId("row-failure-action");
    expect(offActions).toHaveLength(1);
    expect(offActions[0].textContent).toBe("Retry now");

    const signedOut = screen.getAllByTestId("server-placeholder-row").find((r) => r.getAttribute("data-server-id") === "s3")!;
    expect(within(signedOut).getByTestId("row-failure").textContent).toBe("Sign in to Charlie");
    const signIn = within(signedOut).getAllByTestId("row-failure-action");
    expect(signIn).toHaveLength(1);

    // Retry now re-checks B only.
    net.calls = [];
    net.boot["bravo.k2.dev"] = READY;
    fireEvent.click(offActions[0]);
    await waitFor(() => expect(net.calls.some((u) => u.startsWith("https://bravo.k2.dev/boot-status"))).toBe(true));
    expect(net.calls.every((u) => u.startsWith("https://bravo.k2.dev/"))).toBe(true);

    // Sign in opens THAT server's sheet, without switching the active one.
    fireEvent.click(signIn[0]);
    const sheet = screen.getByTestId("row-sign-in");
    expect(within(sheet).getByTestId("overlay-add-server")).not.toBeNull();
    expect((within(sheet).getByDisplayValue("charlie.k2.dev") as HTMLInputElement).value).toBe("charlie.k2.dev");
    expect(useServersStore.getState().activeServerId).toBe("s1");
  });

  it("a server below the 0.41.6 floor offers the old way (switch)", async () => {
    net.boot["bravo.k2.dev"] = { ...READY, version: "0.40.2" };
    seed();
    setFlag(true);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("row-failure")).not.toHaveLength(0));
    const row = screen.getAllByTestId("server-placeholder-row").find((r) => r.getAttribute("data-server-id") === "s2")!;
    expect(within(row).getByTestId("row-failure").textContent).toBe("Bravo needs an update");
    const action = within(row).getByTestId("row-failure-action");
    expect(action.getAttribute("data-action")).toBe("switch");
    fireEvent.click(action);
    await waitFor(() => expect(useServersStore.getState().activeServerId).toBe("s2"));
  });

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
