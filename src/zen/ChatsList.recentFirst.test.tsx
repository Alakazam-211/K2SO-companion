// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "./multi/prefs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  inspectProjectsSummary: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getToken: vi.fn(() => ""),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setProjectPinned: vi.fn(async () => ({ ok: true, data: {} })),
  reorderProjects: vi.fn(async () => ({ ok: true, data: {} })),
  assignFocusGroup: vi.fn(async () => ({ ok: true, data: {} })),
  createFocusGroup: vi.fn(),
  getAppSettings: vi.fn(async () => ({ ok: true, data: {} })),
  getFocusGroupsList: vi.fn(async () => ({ ok: true, data: [] })),
  createWorkspace: vi.fn(),
  getFsInfo: vi.fn(async () => ({ ok: true, data: { home: "/Users/r" } })),
  updateProjectLook: vi.fn(),
  ensurePinnedChat: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(async () => "still-valid"),
}));

vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => ({ username: "u", owner: true, role: "owner" }),
}));

import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { homeAddress, useHomesStore } from "./homes";
import { recentSentKey, useRecentFirstStore } from "./recentFirst";
import { FOCUS_OFF, type ServerProject } from "./serverPins";
import { useZenStore } from "./zenStore";

// "Recent agents first" (phone-only setting) on the Agents and Home lists.

const agent = (id: string, addr: string) => ({ id, name: addr, initial: addr[0].toUpperCase(), path: id, addr, kind: "agent" as const });
const LA = agent("/a", "alpha");
const LB = agent("/b", "bravo");
const LC = agent("/c", "charlie");
const LD = agent("/d", "delta");
function project(id: string, handle: string, extra: Partial<ServerProject> = {}): ServerProject {
  return { id, name: handle, path: `/${handle[0]}`, handle, pinned: false, tabOrder: 0, focusGroupId: null, ...extra };
}
const PROJECTS = [project("pa", "alpha", { pinned: true }), project("pb", "bravo"), project("pc", "charlie"), project("pd", "delta")];
const HOST = "example.k2.dev";

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

/** Agents list rows below the pin grid, top to bottom. */
function agentRows(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-pin-from="list"]')].map((el) => el.dataset.pinId ?? "");
}

function homeRows(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-home-row]")].map(
    (el) => (el.dataset.homeRow ?? "").split("::")[0]
  );
}

function sent(serverId: string, addr: string, at: number) {
  act(() => useRecentFirstStore.getState().markSent(recentSentKey(serverId, { addr }), at));
}

beforeEach(() => {
  useMultiServerPrefs.setState({ multiServer: false });
  localStorage.clear();
  useHomesStore.getState().reload();
  useRecentFirstStore.getState().reload();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: `https://${HOST}`, username: "u", rememberPassword: false },
      { id: "s2", nickname: "Lab box", url: "http://192.168.1.20:38471", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t", s2: "t2" },
    recovery: { s1: "connected", s2: "connected" },
  });
  useZenStore.setState({
    agentSource: "stub",
    agents: [LA, LB, LC, LD],
    screen: "list",
    agentId: "",
    pinnedIds: ["/a"],
    serverProjects: PROJECTS,
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    lastAtByKey: {},
  });
});

afterEach(() => cleanup());

describe("Agents list", () => {
  it("off (default): today's order, whatever this phone sent", () => {
    sent("s1", "delta", 200);
    mount();
    expect(useRecentFirstStore.getState().on).toBe(false);
    expect(agentRows()).toEqual(["/b", "/c", "/d"]);
  });

  it("on: pins stay in the grid; latest sends lead; the rest keep their order; live re-sort", () => {
    useRecentFirstStore.getState().setOn(true);
    sent("s1", "charlie", 100);
    sent("s1", "delta", 200);
    // Same handle on another server: not this server's bravo.
    sent("s2", "bravo", 999);
    mount();
    expect(within(screen.getByTestId("chats-pins")).getByLabelText(/alpha/)).not.toBeNull();
    expect(agentRows()).toEqual(["/d", "/c", "/b"]);
    sent("s1", "bravo", 300);
    expect(agentRows()).toEqual(["/b", "/d", "/c"]);
    act(() => useRecentFirstStore.getState().setOn(false));
    expect(agentRows()).toEqual(["/b", "/c", "/d"]);
  });
});

describe("Home list", () => {
  function seedHome() {
    const h = useHomesStore.getState();
    for (const [handle, ws] of [["bravo", "pb"], ["charlie", "pc"], ["alpha", "pa"], ["delta", "pd"]]) {
      h.addRow(h.selectedId, { address: homeAddress(handle, HOST), workspaceId: ws, label: handle });
    }
  }

  it("off: the Home's own order; Move up / down in the menu", () => {
    seedHome();
    sent("s1", "delta", 200);
    mount();
    fireEvent.click(screen.getByTestId("list-tab-home"));
    expect(homeRows()).toEqual(["bravo", "charlie", "alpha", "delta"]);
    fireEvent.contextMenu(screen.getByTestId("home-row-charlie"));
    expect(screen.getByTestId("home-menu-down")).not.toBeNull();
  });

  it("on: latest sends first (a pinned agent too), then the Home's order; no Move up / down", () => {
    seedHome();
    useRecentFirstStore.getState().setOn(true);
    sent("s1", "charlie", 100);
    sent("s1", "delta", 200);
    sent("s2", "bravo", 999);
    mount();
    fireEvent.click(screen.getByTestId("list-tab-home"));
    expect(homeRows()).toEqual(["delta", "charlie", "bravo", "alpha"]);
    fireEvent.contextMenu(screen.getByTestId("home-row-charlie"));
    expect(screen.queryByTestId("home-menu-down")).toBeNull();
    expect(screen.queryByTestId("home-menu-up")).toBeNull();
    expect(screen.getByTestId("home-menu-remove")).not.toBeNull();
  });

  it("turning it on re-sorts Home at once, a pinned row included", () => {
    seedHome();
    sent("s1", "alpha", 300);
    sent("s1", "delta", 200);
    mount();
    fireEvent.click(screen.getByTestId("list-tab-home"));
    expect(homeRows()).toEqual(["bravo", "charlie", "alpha", "delta"]);
    act(() => useRecentFirstStore.getState().setOn(true));
    expect(homeRows()).toEqual(["alpha", "delta", "bravo", "charlie"]);
    act(() => sent("s1", "charlie", 400));
    expect(homeRows()).toEqual(["charlie", "alpha", "delta", "bravo"]);
  });
});
