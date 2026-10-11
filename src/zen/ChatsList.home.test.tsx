// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { OTHER_SERVERS_SOON } from "./AddAgentSheet";
import { HOME_EMPTY_BODY, HOME_EMPTY_TITLE } from "./HomeList";
import { HOMES_STORAGE_KEY, LIST_TAB_KEY, homeAddress, parseHomesDoc, useHomesStore } from "./homes";
import { FOCUS_OFF, type ServerProject } from "./serverPins";
import { useZenStore } from "./zenStore";

const LA = { id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" as const };
const LB = { id: "/b", name: "bravo", initial: "B", path: "/b", addr: "bravo", kind: "agent" as const };
const SIDE = { id: "/a#2", name: "alpha 2", initial: "A", path: "/a", addr: "alpha/2", kind: "agent" as const };
function project(id: string, handle: string, extra: Partial<ServerProject> = {}): ServerProject {
  return { id, name: handle, path: `/${handle[0]}`, handle, pinned: false, tabOrder: 0, focusGroupId: null, ...extra };
}
const PROJECTS = [project("pa", "alpha", { pinned: true }), project("pb", "bravo")];
const HOST = "example.k2.dev";

function storedRows() {
  return parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY))?.homes[0].rows ?? [];
}

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

function goHome() {
  fireEvent.click(screen.getByTestId("list-tab-home"));
}

beforeEach(() => {
  localStorage.clear();
  useHomesStore.getState().reload();
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
    agents: [LA, LB, SIDE],
    screen: "list",
    agentId: "",
    pinnedIds: ["/a"],
    serverProjects: PROJECTS,
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
  });
});

afterEach(() => cleanup());

describe("Home | Agents toggle (HM1)", () => {
  it("sits left of the search field, Agents selected by default", () => {
    mount();
    const toggle = screen.getByTestId("list-tab-toggle");
    const input = screen.getByRole("searchbox", { name: "Search" });
    const bar = toggle.parentElement as HTMLElement;
    expect(bar.contains(input)).toBe(true);
    // Toggle is before the search field in the bar.
    expect(toggle.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.firstElementChild).toBe(toggle);
    expect(toggle.getAttribute("data-tab")).toBe("agents");
    expect(screen.getByTestId("list-tab-agents").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("list-tab-home").getAttribute("aria-pressed")).toBe("false");
    // Inset thumb on the Agents half; desktop Garden icons.
    expect(screen.getByTestId("list-tab-thumb").style.transform).toBe("translateX(100%)");
    expect(screen.getByTestId("home-icon").getAttribute("stroke-width")).toBe("1.7");
    expect(screen.getByTestId("agent-icon").getAttribute("stroke-width")).toBe("1.7");
    expect(screen.getByTestId("chats-title").textContent).toBe("Agents");
  });

  it("only the Agents page gets it, not the Servers sheet's bar", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Server / }));
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.getAllByTestId("list-tab-toggle")).toHaveLength(1);
    expect(within(screen.getByTestId("overlay-servers")).queryByTestId("list-tab-toggle")).toBeNull();
  });

  it("remembers the selection on this device", () => {
    const first = mount();
    goHome();
    expect(localStorage.getItem(LIST_TAB_KEY)).toBe("home");
    expect(screen.getByTestId("list-tab-thumb").style.transform).toBe("translateX(0%)");
    first.unmount();
    mount();
    expect(screen.getByTestId("list-tab-toggle").getAttribute("data-tab")).toBe("home");
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(localStorage.getItem(LIST_TAB_KEY)).toBe("agents");
  });
});

describe("Home view (HM3/HM7)", () => {
  it("seeds Home and shows the empty tile; no pin grid", () => {
    mount();
    expect(screen.getByTestId("chats-pins")).not.toBeNull();
    goHome();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    const empty = screen.getByTestId("home-empty");
    expect(empty.textContent).toContain(HOME_EMPTY_TITLE);
    expect(empty.textContent).toContain(HOME_EMPTY_BODY);
    expect(empty.className).toMatch(/zen-glass/);
    expect(parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY))?.homes[0].name).toBe("Home");
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Home");
  });

  it("lists the Home's rows with the Agents row look; other-server rows are greyed with a chip", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
    h.addRow(h.selectedId, { address: homeAddress("lab", "192.168.1.20:38471"), workspaceId: null, label: "Lab agent" });
    mount();
    goHome();
    const list = screen.getByTestId("home-list");
    const here = screen.getByTestId("home-row-bravo");
    expect(within(here).getByTestId("row-name").textContent).toBe("bravo");
    expect(within(here).getByTestId("workspace-avatar")).not.toBeNull();
    expect(within(here).queryByTestId("row-server-chip")).toBeNull();
    expect(here.style.opacity).toBe("1");
    const remote = screen.getByTestId("home-row-lab");
    expect(remote.style.opacity).toBe("0.55");
    expect(within(remote).getByTestId("row-server-chip").textContent).toBe("Lab box");
    expect(within(remote).getByTestId("row-preview").textContent).toBe("On Lab box");
    // Home rows never join the pin / group gestures.
    expect(list.querySelector("[data-pin-id]")).toBeNull();
    expect(list.querySelector("[data-swipe-action]")).toBeNull();
  });

  it("an active-server row opens its chat; another server's switches, then opens", async () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
    h.addRow(h.selectedId, { address: homeAddress("lab", "192.168.1.20:38471"), workspaceId: null, label: "Lab" });
    const hydrate = vi.fn(async () => {});
    useZenStore.setState({ hydrateAgents: hydrate });
    mount();
    goHome();
    fireEvent.click(screen.getByTestId("home-row-bravo"));
    expect(useZenStore.getState().agentId).toBe("/b");
    useZenStore.setState({ screen: "list", agentId: "" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("home-row-lab"));
    });
    expect(connectServer).toHaveBeenCalledWith("s2");
    expect(useServersStore.getState().activeServerId).toBe("s2");
    expect(hydrate).toHaveBeenCalledWith({ resumeId: "lab" });
  });
});

describe("Home title dropdown (HM4)", () => {
  it("lists Homes with a check; New Home…, Rename…, Delete (off on the last)", () => {
    mount();
    goHome();
    fireEvent.click(screen.getByTestId("chats-title-home"));
    const menu = screen.getByTestId("home-title-menu");
    expect(menu.className).toMatch(/zen-glass/);
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(1);
    expect(within(menu).getByTestId("home-check")).not.toBeNull();
    expect((screen.getByTestId("home-menu-delete") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("home-menu-new"));
    fireEvent.change(screen.getByTestId("home-name-input"), { target: { value: "Work" } });
    fireEvent.click(screen.getByTestId("home-name-save"));
    expect(screen.queryByTestId("home-title-menu")).toBeNull();
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Work");

    fireEvent.click(screen.getByTestId("chats-title-home"));
    fireEvent.click(screen.getByTestId("home-menu-rename"));
    expect((screen.getByTestId("home-name-input") as HTMLInputElement).value).toBe("Work");
    fireEvent.change(screen.getByTestId("home-name-input"), { target: { value: "Office" } });
    fireEvent.click(screen.getByTestId("home-name-save"));
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Office");

    fireEvent.click(screen.getByTestId("chats-title-home"));
    expect(within(screen.getByTestId("home-title-menu")).getAllByRole("menuitemradio")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("home-menu-delete"));
    fireEvent.click(screen.getByTestId("home-menu-delete-confirm"));
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Home");
    expect(useHomesStore.getState().homes).toHaveLength(1);

    // Picking another Home switches the list.
    useHomesStore.getState().createHome("Second");
    useHomesStore.getState().selectHome(useHomesStore.getState().homes[0].id);
    fireEvent.click(screen.getByTestId("chats-title-home"));
    fireEvent.click(screen.getByText("Second"));
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Second");
  });

  it("the Agents tab keeps its own title", () => {
    useZenStore.setState({
      focus: { enabled: true, currentId: "g1", groups: [{ id: "g1", name: "Work", color: null }] },
    });
    mount();
    expect(screen.getByTestId("chats-title-group").textContent).toContain("Work");
    goHome();
    expect(screen.queryByTestId("chats-title-group")).toBeNull();
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(screen.getByTestId("chats-title-group").textContent).toContain("Work");
  });
});

describe("+ on Home: Add Agent (HM5)", () => {
  it("+ opens Add Agent on Home and New Workspace on Agents", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByTestId("new-workspace")).not.toBeNull();
    expect(screen.queryByTestId("add-agent")).toBeNull();
    cleanup();
    mount();
    goHome();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(screen.getByTestId("add-agent")).not.toBeNull();
    expect(screen.queryByTestId("new-workspace")).toBeNull();
  });

  it("This server: tapping a row adds it, checks it, keeps the sheet open; no duplicates", () => {
    mount();
    goHome();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    // Main chats only: the sidecar is not offered.
    expect(screen.queryByTestId("add-agent-row-/a#2")).toBeNull();
    const alpha = screen.getByTestId("add-agent-row-/a");
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(alpha);
    expect(screen.getByTestId("add-agent")).not.toBeNull();
    expect(screen.getByTestId("add-agent-row-/a").getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByTestId("add-agent-row-/a")).getByTestId("add-agent-check")).not.toBeNull();
    fireEvent.click(screen.getByTestId("add-agent-row-/a"));
    expect(storedRows()).toEqual([{ address: `alpha::${HOST}`, workspaceId: "pa", label: "alpha" }]);
    // Search over name / path / handle.
    fireEvent.change(screen.getByTestId("add-agent-search"), { target: { value: "brav" } });
    expect(screen.queryByTestId("add-agent-row-/a")).toBeNull();
    fireEvent.click(screen.getByTestId("add-agent-row-/b"));
    expect(storedRows().map((r) => r.label)).toEqual(["alpha", "bravo"]);
    fireEvent.click(screen.getByTestId("add-agent-done"));
    expect(screen.queryByTestId("add-agent")).toBeNull();
    expect(screen.getByTestId("home-row-alpha")).not.toBeNull();
    expect(screen.getByTestId("home-row-bravo")).not.toBeNull();
  });

  it("groups This server by focus group when groups are on", () => {
    useZenStore.setState({
      focus: { enabled: true, currentId: "g1", groups: [{ id: "g1", name: "Work", color: "#f00" }] },
      serverProjects: [project("pa", "alpha", { focusGroupId: "g1" }), project("pb", "bravo")],
    });
    mount();
    goHome();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const work = screen.getByTestId("add-agent-section-g1");
    expect(within(work).getByTestId("add-agent-row-/a")).not.toBeNull();
    expect(within(screen.getByTestId("add-agent-section-none")).getByTestId("add-agent-row-/b")).not.toBeNull();
  });

  it("Other servers: one coming-soon section per other saved server", () => {
    mount();
    goHome();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    fireEvent.click(screen.getByTestId("add-agent-seg-other"));
    expect(screen.queryByTestId("add-agent-server-s1")).toBeNull();
    const lab = screen.getByTestId("add-agent-server-s2");
    expect(lab.textContent).toContain("Lab box");
    expect(screen.getByTestId("add-agent-server-status-s2").textContent).toBe(OTHER_SERVERS_SOON);
  });
});

describe("Remove from Home (HM6)", () => {
  beforeEach(() => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("alpha", HOST), workspaceId: "pa", label: "alpha" });
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
  });

  it("long-press opens Remove from Home; it only touches local storage", () => {
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-alpha"));
    const menu = screen.getByTestId("home-row-menu");
    expect(menu.className).toMatch(/zen-glass/);
    fireEvent.click(screen.getByTestId("home-menu-remove"));
    expect(screen.queryByTestId("home-row-alpha")).toBeNull();
    expect(storedRows().map((r) => r.label)).toEqual(["bravo"]);
    // The agent is still on the Agents list.
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(screen.getByLabelText("Pinned alpha")).not.toBeNull();
  });

  it("a held press opens the same menu; Move down reorders", () => {
    vi.useFakeTimers();
    try {
      mount();
      goHome();
      fireEvent.pointerDown(screen.getByTestId("home-row-alpha"), { clientX: 100, clientY: 200, button: 0, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.click(screen.getByTestId("home-menu-down"));
      expect(storedRows().map((r) => r.label)).toEqual(["bravo", "alpha"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swipe left reveals Remove; swipe right does nothing on Home rows", () => {
    mount();
    goHome();
    const row = screen.getByTestId("home-row-bravo");
    fireEvent.pointerDown(row, { clientX: 200, clientY: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(row, { clientX: 260, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(row, { clientX: 260, clientY: 200, pointerId: 2 });
    expect(row.style.transform).toBe("translateX(0px)");
    fireEvent.pointerDown(row, { clientX: 200, clientY: 200, button: 0, pointerId: 3 });
    fireEvent.pointerMove(row, { clientX: 100, clientY: 202, pointerId: 3 });
    fireEvent.pointerUp(row, { clientX: 100, clientY: 202, pointerId: 3 });
    expect(row.style.transform).toBe("translateX(-96px)");
    fireEvent.click(screen.getByTestId("home-remove-bravo"));
    expect(storedRows().map((r) => r.label)).toEqual(["alpha"]);
    expect(screen.queryByTestId("home-row-bravo")).toBeNull();
  });
});
