// @vitest-environment jsdom
// Multi-server S3b: Homes across servers (PRD §14 HM3/HM5/HM8, MA24).
//
// A is the active server throughout. The transport is mocked at the HTTP
// plugin; the client, scopes, pool, remote rows and stores are real, so
// every assertion about "which server" is about the wire:
//   - Add Agent → Other servers lists each server with ITS OWN login, no
//     switch, never A's token anywhere else (no fallback);
//   - per-section states: sign in, offline, needs an update, no access,
//     failed (Retry), and the list;
//   - adding from B writes `handle::bravo.k2.dev`, deduped;
//   - a Home row from B opens a ROOM on B (active unchanged), Back → Home;
//   - Home failure rows carry one action scoped to their server;
//   - rename repair re-keys a row from B's fresh list;
//   - flag off: Home is A's rows only (B's hidden, kept), Add Agent has no
//     Other servers, the pill names A, nothing sent to B.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

type Call = { method: string; url: string; host: string; path: string; auth: string | null };

const net = vi.hoisted(() => ({
  calls: [] as Call[],
  /** host → overrides */
  boot: {} as Record<string, unknown | null>,
  role: {} as Record<string, string>,
  failLists: new Set<string>(),
  projects: {} as Record<string, unknown[]>,
  agents: {} as Record<string, unknown[]>,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const u = new URL(url);
    const auth = init?.headers?.Authorization ?? null;
    net.calls.push({ method: init?.method || "GET", url, host: u.host, path: u.pathname, auth });
    const body = (v: unknown, status = 200) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    if (u.pathname === "/boot-status") {
      const b = net.boot[u.host];
      if (b === null) throw new Error("Could not reach server: connection refused");
      return body(b ?? { version: "0.45.5", protocol: 1, phase: "ready", instanceId: `i-${u.host}`, features: ["daemon-activity"] });
    }
    if (u.pathname === "/cli/auth/whoami") {
      return body({ username: "u", role: net.role[u.host] ?? "member", mustChangePassword: false });
    }
    if (u.pathname === "/cli/presence/summary") {
      return body({
        workspaces: [],
        agentActivity: u.host === "bravo.k2.dev" ? [{ workspaceId: "pd", status: "working", display: "working" }] : [],
      });
    }
    if (net.failLists.has(u.host) && u.pathname.startsWith("/cli/")) return body({ error: "boom" }, 500);
    switch (u.pathname) {
      case "/cli/agent/list":
        return body({ ok: true, agents: net.agents[u.host] ?? [] });
      case "/cli/projects/list":
        return body(net.projects[u.host] ?? []);
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([]);
      case "/cli/thread":
        return body({ items: [{ seq: 1, from: "docs", text: "hi from B", at: 1 }], conversation_id: "cb" });
      case "/cli/activity/snapshot":
        return body({ rows: [], workspaces: [] });
      default:
        return body({});
    }
  }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));
vi.mock("../lib/revive", async (orig) => ({
  ...(await orig<typeof import("../lib/revive")>()),
  connectServer: vi.fn(async () => "still-valid"),
  revive: vi.fn(async () => "still-valid"),
}));
vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => ({ username: "u", owner: true, role: "owner" }),
}));

import { connectServer } from "../lib/revive";
import { __resetScopesForTests } from "../api/scope";
import { __resetDialQueueForTests } from "../api/dialQueue";
import { __resetHttpCapForTests } from "../api/httpCap";
import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { HOMES_STORAGE_KEY, homeAddress, parseHomesDoc, useHomesStore } from "./homes";
import { pool } from "./multi/pool";
import { useMultiServerPrefs } from "./multi/prefs";
import { __resetRemoteIconsForTests } from "./multi/remoteIcons";
import { __resetRemoteRowsForTests, useRemoteRows } from "./multi/remoteRows";
import { resetRowPreviewMemo } from "./rowPreviewCache";
import { FOCUS_OFF } from "./serverPins";
import { dragGrip } from "../test/rearrangeDrag";
import { roomServerId } from "./zenScope";
import { resetThreadPreviewQueue, useZenStore } from "./zenStore";

class MockWS {
  static urls: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.urls.push(url);
  }
  send() {}
  close() {}
}

const sv = (id: string, nickname: string, host: string) => ({
  id,
  nickname,
  url: `https://${host}`,
  username: "u",
  rememberPassword: false,
});
const A = sv("a", "Alpha", "alpha.k2.dev");
const B = sv("b", "Bravo", "bravo.k2.dev");
const C = sv("c", "Charlie", "charlie.k2.dev"); // no login on this phone
const D = sv("d", "Delta", "delta.k2.dev"); // offline
const E = sv("e", "Echo", "echo.k2.dev"); // below the 0.41.6 floor
const F = sv("f", "Foxtrot", "fox.k2.dev"); // viewer: no access
const G = sv("g", "Golf", "golf.k2.dev"); // lists fail (500)
const ALL = [A, B, C, D, E, F, G];
const TOKENS: Record<string, string> = { a: "tok-a", b: "tok-b", d: "tok-d", e: "tok-e", f: "tok-f", g: "tok-g" };
const HOST_OF_TOKEN: Record<string, string> = {
  "tok-a": "alpha.k2.dev",
  "tok-b": "bravo.k2.dev",
  "tok-d": "delta.k2.dev",
  "tok-e": "echo.k2.dev",
  "tok-f": "fox.k2.dev",
  "tok-g": "golf.k2.dev",
};

/** No fallback (MS7, MS32): every token went only to its own server. */
function expectTokensStayHome() {
  for (const c of net.calls) {
    if (!c.auth) continue;
    const tok = c.auth.replace(/^Bearer /, "");
    expect(`${c.host} ${tok}`).toBe(`${HOST_OF_TOKEN[tok]} ${tok}`);
  }
}

const listCalls = (host: string) =>
  net.calls.filter((c) => c.host === host && c.path === "/cli/agent/list");

function storedRows() {
  return parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY))?.homes[0].rows ?? [];
}

function seed(servers = ALL, tokens = TOKENS) {
  useServersStore.setState({
    hydrated: true,
    servers,
    activeServerId: "a",
    tokens,
    recovery: { a: "connected" },
  });
  useZenStore.setState({
    agentSource: "live",
    agents: [{ id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" }],
    agentError: null,
    serverProjects: [{ id: "pa", name: "alpha", path: "/a", handle: "alpha", pinned: false, tabOrder: 0, focusGroupId: null }],
    pinnedIds: [],
    hiddenSidecarAddrs: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    screen: "list",
    agentId: "",
  });
}

function addHomeRow(handle: string, host: string, workspaceId: string | null = null, label = handle) {
  const h = useHomesStore.getState();
  h.addRow(h.selectedId, { address: homeAddress(handle, host), workspaceId, label });
}

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

function setFlag(on: boolean) {
  act(() => useMultiServerPrefs.getState().setMultiServer(on));
}

function goHome() {
  fireEvent.click(screen.getByTestId("list-tab-home"));
}

function openOtherServers() {
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  fireEvent.click(screen.getByTestId("add-agent-seg-other"));
}

const sectionState = (id: string) =>
  screen.queryByTestId(`add-agent-server-status-${id}`)?.getAttribute("data-state") ??
  (screen.queryByTestId(`add-agent-server-list-${id}`) ? "list" : null);

const homeRow = (address: string) => document.querySelector(`[data-home-row="${address}"]`) as HTMLElement;

beforeEach(() => {
  net.calls = [];
  net.boot = {
    "delta.k2.dev": null,
    "echo.k2.dev": { version: "0.40.2", protocol: 1, phase: "ready", instanceId: "ie", features: [] },
  };
  net.role = { "fox.k2.dev": "viewer" };
  net.failLists = new Set(["golf.k2.dev"]);
  const docs = { name: "docs", path: "/srv/docs", mode: "pod", enabled: true, live: true };
  const ops = { name: "ops", path: "/srv/ops", mode: "pod", enabled: true, live: true };
  net.agents = { "bravo.k2.dev": [docs, ops], "echo.k2.dev": [docs], "fox.k2.dev": [docs] };
  net.projects = {
    "bravo.k2.dev": [
      { id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 },
      { id: "po", name: "Ops", handle: "ops", path: "/srv/ops", pinned: 0, tab_order: 1 },
    ],
  };
  MockWS.urls = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  sessionStorage.clear();
  useHomesStore.getState().reload();
  __resetScopesForTests();
  __resetDialQueueForTests();
  __resetHttpCapForTests();
  __resetRemoteRowsForTests();
  __resetRemoteIconsForTests();
  resetThreadPreviewQueue();
  resetRowPreviewMemo();
  for (const s of ALL) pool.forget(s.id);
  useMultiServerPrefs.setState({ multiServer: false });
  vi.mocked(connectServer).mockClear();
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  vi.unstubAllGlobals();
});

describe("Add Agent → Other servers (HM5, flag on)", () => {
  it("one section per other server, each read with its own login; no switch, no fallback; every state", async () => {
    seed();
    setFlag(true);
    mount();
    goHome();
    openOtherServers();
    // A–Z, the active server excluded.
    const titles = screen
      .getAllByTestId(/^add-agent-server-[a-z]$/)
      .map((n) => n.getAttribute("data-testid")!.slice(-1));
    expect(titles).toEqual(["b", "c", "d", "e", "f", "g"]);
    await waitFor(() =>
      expect(["b", "c", "d", "e", "f", "g"].map(sectionState)).toEqual([
        "list",
        "signin",
        "offline",
        "too-old",
        "no-access",
        "failed",
      ])
    );
    expect(screen.getByTestId("add-agent-server-status-e").textContent).toContain("Echo needs an update");
    expect(screen.getByTestId("add-agent-server-status-f").textContent).toContain("can’t list agents");
    expect(screen.getByTestId("add-agent-server-status-g").textContent).toContain("Couldn’t list agents");
    // B's own list, read at B with B's token.
    const b = screen.getByTestId("add-agent-server-list-b");
    expect(within(b).getByTestId("add-agent-row-b:/srv/docs")).not.toBeNull();
    expect(listCalls("bravo.k2.dev").every((c) => c.auth === "Bearer tok-b")).toBe(true);
    expect(listCalls("bravo.k2.dev").length).toBeGreaterThan(0);
    // Charlie has no login: nothing with a token is ever sent there.
    expect(net.calls.filter((c) => c.host === "charlie.k2.dev" && c.auth)).toEqual([]);
    expectTokensStayHome();
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(roomServerId()).toBeNull();
    expect(connectServer).not.toHaveBeenCalled();

    // Retry on a failed section re-reads THAT server only.
    net.calls = [];
    net.failLists.delete("golf.k2.dev");
    net.agents["golf.k2.dev"] = [{ name: "golfer", path: "/srv/golf", mode: "pod", enabled: true, live: true }];
    net.projects["golf.k2.dev"] = [{ id: "pg", name: "Golfer", handle: "golfer", path: "/srv/golf", pinned: 0, tab_order: 0 }];
    fireEvent.click(screen.getByTestId("add-agent-server-action-g"));
    await waitFor(() => expect(sectionState("g")).toBe("list"));
    expect(net.calls.every((c) => c.host === "golf.k2.dev")).toBe(true);

    // Sign in on Charlie: its own sheet, above the picker; no switch.
    fireEvent.click(screen.getByTestId("add-agent-server-action-c"));
    const sheet = screen.getByTestId("row-sign-in");
    expect(sheet.style.zIndex).toBe("40");
    expect(within(sheet).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(sectionState("c")).toBe("signing-in");
  });

  it("adding from B writes handle::bravo.k2.dev with B's workspace id; checked, unchecks to remove; search covers every section", async () => {
    seed([A, B, G], { a: "tok-a", b: "tok-b", g: "tok-g" });
    setFlag(true);
    mount();
    goHome();
    openOtherServers();
    const docs = await screen.findByTestId("add-agent-row-b:/srv/docs");
    expect(docs.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(docs);
    expect(storedRows()).toEqual([expect.objectContaining({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "docs" })]);
    expect(screen.getByTestId("add-agent-row-b:/srv/docs").getAttribute("aria-pressed")).toBe("true");
    // Uncheck takes it off the Home; a re-tap adds it once again.
    fireEvent.click(screen.getByTestId("add-agent-row-b:/srv/docs"));
    expect(storedRows()).toEqual([]);
    expect(screen.getByTestId("add-agent-row-b:/srv/docs").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("add-agent-row-b:/srv/docs"));
    expect(storedRows()).toHaveLength(1);
    // The sheet stays open; one search box over every section.
    fireEvent.change(screen.getByTestId("add-agent-search"), { target: { value: "ops" } });
    expect(screen.queryByTestId("add-agent-row-b:/srv/docs")).toBeNull();
    expect(screen.getByTestId("add-agent-row-b:/srv/ops")).not.toBeNull();
    // The same search runs on This server.
    fireEvent.click(screen.getByTestId("add-agent-seg-this"));
    expect(screen.getByTestId("add-agent-empty").textContent).toBe("No matches.");
    // Never a workspace create.
    expect(net.calls.some((c) => c.path.includes("workspace/create"))).toBe(false);
    expectTokensStayHome();
  });
});

describe("Home list across servers (HM3, flag on)", () => {
  it("a B row shows B's chip and activity; tapping opens a ROOM on B; Back returns to Home", async () => {
    addHomeRow("docs", "bravo.k2.dev", "pd");
    addHomeRow("alpha", "alpha.k2.dev", "pa");
    seed([A, B], { a: "tok-a", b: "tok-b" });
    setFlag(true);
    mount();
    goHome();
    const row = homeRow("docs::bravo.k2.dev");
    await waitFor(() => expect(within(row).getByTestId("row-activity").textContent).toBe("Working"));
    expect(within(row).getByTestId("row-server-chip").textContent).toBe("Bravo");
    // Owner 2026-10: the chip sits right after the name, in the name group,
    // never beside the time.
    const chip = within(row).getByTestId("row-server-chip");
    const name = within(row).getByTestId("row-name");
    expect(name.nextElementSibling).toBe(chip);
    expect(chip.parentElement).toBe(within(row).getByTestId("row-name-group"));
    expect(within(row).getByTestId("row-when").contains(chip)).toBe(false);
    expect(row.getAttribute("data-greyed")).toBeNull();
    // The active server's row carries its own chip with several servers.
    expect(within(homeRow("alpha::alpha.k2.dev")).getByTestId("row-server-chip").textContent).toBe("Alpha");
    await waitFor(() => expect(useRemoteRows.getState().byServer.b?.loadedAt).not.toBeNull());

    net.calls = [];
    await act(async () => {
      fireEvent.click(screen.getByTestId("home-row-docs"));
    });
    await waitFor(() => expect(useZenStore.getState().agentId).toBe("/srv/docs"));
    expect(roomServerId()).toBe("b");
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(connectServer).not.toHaveBeenCalled();
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("docs"));
    // The room talks to B only.
    expect(net.calls.length).toBeGreaterThan(0);
    expect(net.calls.filter((c) => c.path.startsWith("/cli/thread")).every((c) => c.host === "bravo.k2.dev")).toBe(true);
    expectTokensStayHome();

    act(() => useZenStore.getState().closeChat());
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().screen).toBe("list");
    expect(screen.getByTestId("list-tab-toggle").getAttribute("data-tab")).toBe("home");
    expect(screen.getByTestId("home-row-docs")).not.toBeNull();
    expect(useServersStore.getState().activeServerId).toBe("a");
  });

  it("auto reconnect: a row on a server that is down opens its chat (a room there), not just a retry", async () => {
    addHomeRow("dd", "delta.k2.dev");
    seed();
    setFlag(true);
    mount();
    goHome();
    await waitFor(() =>
      expect(homeRow("dd::delta.k2.dev").querySelector("[data-testid=row-failure]")?.getAttribute("data-state")).toBe(
        "offline"
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("home-row-dd"));
    });
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    expect(roomServerId()).toBe("d");
    expect(useServersStore.getState().activeServerId).toBe("a");
  });

  it("pull to refresh on Home retries every saved server at once", async () => {
    seed();
    setFlag(true);
    mount();
    goHome();
    await waitFor(() => expect(pool.entry("d")?.reach).toBe("offline"));
    net.calls = [];
    const list = screen.getByTestId("chats-list");
    fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 102, clientY: 140 }] });
    expect(screen.getByTestId("chats-pull-refresh").getAttribute("data-state")).toBe("pulling");
    fireEvent.touchMove(list, { touches: [{ clientX: 103, clientY: 200 }] });
    expect(screen.getByTestId("chats-pull-refresh").getAttribute("data-state")).toBe("armed");
    fireEvent.touchEnd(list, { touches: [] });
    expect(screen.getByTestId("chats-pull-refresh").getAttribute("data-state")).toBe("refreshing");
    await waitFor(() => {
      const hosts = new Set(net.calls.filter((c) => c.path === "/boot-status").map((c) => c.host));
      for (const sv of ALL) expect(hosts.has(sv.url.replace("https://", ""))).toBe(true);
    });
    expect(useServersStore.getState().activeServerId).toBe("a");
  });

  it("a sideways swipe or a short pull does not refresh", async () => {
    seed();
    setFlag(true);
    mount();
    goHome();
    await waitFor(() => expect(pool.entry("d")?.reach).toBe("offline"));
    net.calls = [];
    const list = screen.getByTestId("chats-list");
    fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 200, clientY: 130 }] });
    fireEvent.touchEnd(list, { touches: [] });
    fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 130 }] });
    fireEvent.touchEnd(list, { touches: [] });
    expect(screen.queryByTestId("chats-pull-refresh")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(net.calls.filter((c) => c.path === "/boot-status")).toEqual([]);
  });

  it("failure rows: the §6.8 copy and one action, scoped to the row's server", async () => {
    addHomeRow("cc", "charlie.k2.dev");
    addHomeRow("dd", "delta.k2.dev");
    addHomeRow("ee", "echo.k2.dev");
    addHomeRow("ff", "fox.k2.dev");
    seed();
    setFlag(true);
    mount();
    goHome();
    const state = (addr: string) => homeRow(addr).querySelector("[data-testid=row-failure]")?.getAttribute("data-state");
    await waitFor(() =>
      expect(
        ["cc::charlie.k2.dev", "dd::delta.k2.dev", "ee::echo.k2.dev", "ff::fox.k2.dev"].map(state)
      ).toEqual([
        "signin-required",
        "offline",
        "too-old",
        "no-access",
      ])
    );
    const actions = (addr: string) => within(homeRow(addr)).queryAllByTestId("row-failure-action");
    expect(homeRow("dd::delta.k2.dev").getAttribute("data-greyed")).toBe("1");
    expect(within(homeRow("dd::delta.k2.dev")).getByTestId("row-failure").textContent).toBe("Reconnecting…");
    // A server that is down reads as being retried, not dead.
    expect(within(homeRow("dd::delta.k2.dev")).getByTestId("row-reconnecting")).not.toBeNull();
    expect(actions("ff::fox.k2.dev")).toHaveLength(0);
    expect(within(homeRow("ff::fox.k2.dev")).getByTestId("row-failure").textContent).toBe("No access on Foxtrot");

    // Retry now re-checks Delta only.
    net.calls = [];
    fireEvent.click(actions("dd::delta.k2.dev")[0]);
    await waitFor(() => expect(net.calls.some((c) => c.host === "delta.k2.dev" && c.path === "/boot-status")).toBe(true));
    expect(net.calls.every((c) => c.host === "delta.k2.dev")).toBe(true);

    // Sign in to Charlie: that server's sheet, no switch.
    expect(actions("cc::charlie.k2.dev")[0].textContent).toBe("Sign in");
    fireEvent.click(actions("cc::charlie.k2.dev")[0]);
    expect(within(screen.getByTestId("row-sign-in")).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
    expect(useServersStore.getState().activeServerId).toBe("a");
    fireEvent.click(within(screen.getByTestId("row-sign-in")).getByRole("button", { name: /cancel/i }));

    // Below the floor: "Open" switches the old way, then opens the row there.
    const hydrate = vi.fn(async (_opts?: { resumeId?: string }) => {});
    useZenStore.setState({ hydrateAgents: hydrate });
    expect(within(homeRow("ee::echo.k2.dev")).getByTestId("row-failure").textContent).toBe("Echo needs an update");
    await act(async () => {
      fireEvent.click(actions("ee::echo.k2.dev")[0]);
    });
    await waitFor(() => expect(useServersStore.getState().activeServerId).toBe("e"));
    expect(connectServer).toHaveBeenCalledWith("e");
    expect(hydrate).toHaveBeenCalledWith({ resumeId: "ee" });
    expect(roomServerId()).toBeNull();
  });

  it("rename repair: a row whose handle left B follows its workspace id", async () => {
    addHomeRow("olddocs", "bravo.k2.dev", "pd", "old docs");
    seed([A, B], { a: "tok-a", b: "tok-b" });
    setFlag(true);
    mount();
    goHome();
    await waitFor(() =>
      expect(storedRows()).toEqual([expect.objectContaining({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "Docs" })])
    );
    expect(screen.getByTestId("home-row-docs")).not.toBeNull();
  });

  it("remove and reorder stay local across servers", async () => {
    addHomeRow("docs", "bravo.k2.dev", "pd");
    addHomeRow("alpha", "alpha.k2.dev", "pa");
    seed([A, B], { a: "tok-a", b: "tok-b" });
    setFlag(true);
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-docs"));
    net.calls = [];
    fireEvent.click(screen.getByTestId("menu-rearrange"));
    dragGrip(screen.getByTestId("chats-list"), 0, 1);
    expect(storedRows().map((r) => r.address)).toEqual(["alpha::alpha.k2.dev", "docs::bravo.k2.dev"]);
    fireEvent.click(screen.getByTestId("rearrange-done"));
    fireEvent.contextMenu(screen.getByTestId("home-row-docs"));
    fireEvent.click(screen.getByTestId("menu-remove"));
    expect(storedRows().map((r) => r.address)).toEqual(["alpha::alpha.k2.dev"]);
    // Nothing about either edit went to a server.
    expect(net.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("flag off (owner 2026-10): Home is the active server's rows only", () => {
  it("B's rows are hidden but kept; Add Agent has no Other servers; the pill names A; nothing is sent to B", async () => {
    addHomeRow("docs", "bravo.k2.dev", "pd");
    seed([A, B], { a: "tok-a", b: "tok-b" });
    mount();
    goHome();
    expect(screen.queryByTestId("home-row-docs")).toBeNull();
    expect(screen.queryByText("On Bravo")).toBeNull();
    expect(storedRows().map((r) => r.address)).toEqual(["docs::bravo.k2.dev"]);
    expect(screen.getByTestId("server-name").textContent).toBe("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(screen.queryByTestId("add-agent-seg-other")).toBeNull();
    expect(screen.queryByTestId("add-agent-server-b")).toBeNull();
    expect(screen.getByTestId("add-agent-search")).not.toBeNull();
    fireEvent.click(screen.getByTestId("add-agent-done"));
    await new Promise((r) => setTimeout(r, 30));
    expect(net.calls.filter((c) => c.host === "bravo.k2.dev")).toEqual([]);
    expect(useRemoteRows.getState().byServer).toEqual({});
    // Rename repair is a flag-on behaviour.
    expect(storedRows()[0].address).toBe("docs::bravo.k2.dev");
    // Flag back on: B's row is back, and the pill reads All.
    setFlag(true);
    await waitFor(() => expect(screen.getByTestId("home-row-docs")).not.toBeNull());
    expect(screen.getByTestId("server-name").textContent).toBe("All");
  });
});
