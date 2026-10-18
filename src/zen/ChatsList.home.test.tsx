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

import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { ChatsList, ZEN_LIST_CONTENT_INSET } from "./ChatsList";
import { rearrangePadLeft } from "./RearrangeBits";
import { HOME_EMPTY_BODY, HOME_EMPTY_TITLE } from "./HomeList";
import { HOMES_STORAGE_KEY, LIST_TAB_KEY, homeAddress, parseHomesDoc, useHomesStore } from "./homes";
import { FOCUS_OFF, type ServerProject } from "./serverPins";
import { useZenStore } from "./zenStore";
import { dragGrip, holdOpen, menuLabels, tap } from "../test/rearrangeDrag";

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
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
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
    // One definition per icon: the toggle draws the shared ones (`./icons`).
    expect(screen.getByTestId("home-icon").getAttribute("data-k2-icon")).toBe("home");
    expect(screen.getByTestId("agent-icon").getAttribute("data-k2-icon")).toBe("agent");
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

  it("flag off: lists only the active server's rows; other servers' rows are hidden but kept", () => {
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
    // No greyed "On Lab box" row: hidden, never deleted.
    expect(screen.queryByTestId("home-row-lab")).toBeNull();
    expect(screen.queryByText("On Lab box")).toBeNull();
    expect(storedRows().map((r) => r.label)).toEqual(["bravo", "Lab agent"]);
    // Home rows never join the pin / group gestures.
    expect(list.querySelector("[data-pin-id]")).toBeNull();
    expect(list.querySelector("[data-swipe-action]")).toBeNull();
    // Turning the flag back on brings the row back.
    act(() => useMultiServerPrefs.getState().setMultiServer(true));
    expect(screen.getByTestId("home-row-lab")).not.toBeNull();
  });

  it("flag off: the Home pill names the active server (never All) and opens the Servers sheet", () => {
    mount();
    goHome();
    expect(screen.getByTestId("server-name").textContent).toBe("test");
    const pill = screen.getByTestId("chats-header-server");
    expect(pill.getAttribute("aria-label")).toBe("Server test");
    fireEvent.click(pill);
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.queryByTestId("server-filter-menu")).toBeNull();
  });

  it("an active-server row opens its chat", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
    mount();
    goHome();
    fireEvent.click(screen.getByTestId("home-row-bravo"));
    expect(useZenStore.getState().agentId).toBe("/b");
    expect(connectServer).not.toHaveBeenCalled();
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

  it("This server: tapping a row adds it, checks it, keeps the sheet open; tapping a check removes it", () => {
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
    expect(storedRows()).toEqual([expect.objectContaining({ address: `alpha::${HOST}`, workspaceId: "pa", label: "alpha" })]);
    // Uncheck: off the Home, back to the empty ring; a re-tap adds it again.
    expect(screen.getByRole("button", { name: "Remove alpha from Home" })).not.toBeNull();
    fireEvent.click(screen.getByTestId("add-agent-row-/a"));
    expect(storedRows()).toEqual([]);
    expect(screen.getByTestId("add-agent-row-/a").getAttribute("aria-pressed")).toBe("false");
    expect(within(screen.getByTestId("add-agent-row-/a")).queryByTestId("add-agent-check")).toBeNull();
    expect(screen.getByTestId("add-agent")).not.toBeNull();
    fireEvent.click(screen.getByTestId("add-agent-row-/a"));
    expect(storedRows()).toEqual([expect.objectContaining({ address: `alpha::${HOST}`, workspaceId: "pa", label: "alpha" })]);
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

  it("flag off: no This server / Other servers control and no other-server sections", () => {
    mount();
    goHome();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(screen.queryByTestId("add-agent-seg-this")).toBeNull();
    expect(screen.queryByTestId("add-agent-seg-other")).toBeNull();
    expect(screen.queryByRole("group", { name: "Which servers" })).toBeNull();
    expect(screen.queryByTestId("add-agent-other")).toBeNull();
    expect(screen.queryByTestId("add-agent-server-s2")).toBeNull();
    expect(screen.queryByText("Other servers")).toBeNull();
    // Just the active server's list, with search.
    expect(screen.getByTestId("add-agent-this")).not.toBeNull();
    expect(screen.getByTestId("add-agent-search")).not.toBeNull();
    expect(screen.getByTestId("add-agent-row-/a")).not.toBeNull();
  });
});

describe("Home row menu and Rearrange (HM6)", () => {
  beforeEach(() => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("alpha", HOST), workspaceId: "pa", label: "alpha" });
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
  });
  afterEach(() => vi.useRealTimers());

  it("right-click / long-press opens the menu: Open, Rearrange, Remove from Home; Remove only touches local storage", () => {
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-alpha"));
    const menu = screen.getByTestId("home-row-menu");
    expect(menu.className).toMatch(/zen-glass/);
    expect(menuLabels(menu)).toEqual(["Open", "Rearrange", "Remove from Home"]);
    // No Move up / Move down any more.
    expect(screen.queryByTestId("home-menu-up")).toBeNull();
    expect(screen.queryByTestId("home-menu-down")).toBeNull();
    fireEvent.click(screen.getByTestId("menu-remove"));
    expect(screen.queryByTestId("home-row-alpha")).toBeNull();
    expect(storedRows().map((r) => r.label)).toEqual(["bravo"]);
    // The agent is still on the Agents list.
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(screen.getByLabelText("Pinned alpha")).not.toBeNull();
  });

  it("a held press opens the same menu; its release cannot hit an item; Open opens the chat", () => {
    vi.useFakeTimers();
    mount();
    goHome();
    holdOpen(screen.getByTestId("home-row-alpha"));
    expect(useZenStore.getState().screen).toBe("list");
    expect(screen.getByTestId("home-row-menu")).not.toBeNull();
    // A click with no fresh press (the hold's own) is ignored.
    fireEvent.click(screen.getByTestId("menu-remove"));
    expect(storedRows().map((r) => r.label)).toEqual(["alpha", "bravo"]);
    tap(screen.getByTestId("menu-open"));
    expect(screen.queryByTestId("home-row-menu")).toBeNull();
    expect(useZenStore.getState().agentId).toBe("/a");
  });

  it("Rearrange: grips and Done; a drag reorders the Home (synced write); taps are off until Done", () => {
    vi.useFakeTimers();
    mount();
    goHome();
    holdOpen(screen.getByTestId("home-row-alpha"));
    tap(screen.getByTestId("menu-rearrange"));
    const grips = () => screen.queryAllByTestId("rearrange-grip");
    expect(grips().map((g) => g.getAttribute("aria-label"))).toEqual(["Reorder alpha", "Reorder bravo"]);
    expect(screen.getByTestId("rearrange-done")).not.toBeNull();
    fireEvent.click(screen.getByTestId("home-row-alpha"));
    expect(useZenStore.getState().screen).toBe("list");
    holdOpen(screen.getByTestId("home-row-bravo"));
    expect(screen.queryByTestId("home-row-menu")).toBeNull();
    const before = useHomesStore.getState().homes[0].rows.map((r) => `${r.order}@${r.updatedAt}`);
    dragGrip(screen.getByTestId("chats-list"), 0, 1);
    expect(storedRows().map((r) => r.label)).toEqual(["bravo", "alpha"]);
    expect(screen.getAllByTestId("row-name").map((n) => n.textContent)).toEqual(["bravo", "alpha"]);
    // The same Home write as any edit: new order key and stamp for Homes sync.
    expect(useHomesStore.getState().homes[0].rows.map((r) => `${r.order}@${r.updatedAt}`)).not.toEqual(before);
    fireEvent.click(screen.getByTestId("rearrange-done"));
    expect(grips()).toHaveLength(0);
    expect(screen.queryByTestId("rearrange-done")).toBeNull();
    fireEvent.click(screen.getByTestId("home-row-alpha"));
    expect(useZenStore.getState().agentId).toBe("/a");
  });

  it("switching tabs ends Rearrange", () => {
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-alpha"));
    fireEvent.click(screen.getByTestId("menu-rearrange"));
    expect(screen.getByTestId("rearrange-done")).not.toBeNull();
    fireEvent.click(screen.getByTestId("list-tab-agents"));
    expect(screen.queryByTestId("rearrange-done")).toBeNull();
    goHome();
    expect(screen.queryAllByTestId("rearrange-grip")).toHaveLength(0);
  });

  it("flag off: a drag steps past a hidden other-server row (it keeps its place in storage)", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("lab", "192.168.1.20:38471"), workspaceId: null, label: "Lab" });
    h.moveRow(h.selectedId, 2, 1); // alpha, Lab (hidden), bravo
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-alpha"));
    fireEvent.click(screen.getByTestId("menu-rearrange"));
    dragGrip(screen.getByTestId("chats-list"), 0, 1);
    expect(storedRows().map((r) => r.label)).toEqual(["Lab", "bravo", "alpha"]);
    expect(screen.getAllByTestId("row-name").map((n) => n.textContent)).toEqual(["bravo", "alpha"]);
  });

  it("no swipe: a sideways drag on a Home row reveals nothing", () => {
    mount();
    goHome();
    const row = screen.getByTestId("home-row-bravo");
    fireEvent.pointerDown(row, { clientX: 200, clientY: 200, button: 0, pointerId: 3 });
    fireEvent.pointerMove(row, { clientX: 100, clientY: 202, pointerId: 3 });
    fireEvent.pointerUp(row, { clientX: 100, clientY: 202, pointerId: 3 });
    expect(row.style.transform).toBe("");
    expect(screen.queryByTestId("home-remove-bravo")).toBeNull();
    expect(storedRows().map((r) => r.label)).toEqual(["alpha", "bravo"]);
    const hint = document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).not.toMatch(/Swipe/);
    expect(hint.textContent).toMatch(/Press and hold/);
  });
});

describe("Row dividers (Rosson 2026-10-18)", () => {
  // The divider spans the text column: row left padding + 50px avatar +
  // 10px gap, to the row's right padding (the chevron's right edge).
  // jsdom normalizes calc(); compare against a probe normalized the same way.
  const css = (prop: "left" | "right", v: string) => {
    const probe = document.createElement("span");
    probe.style[prop] = v;
    return probe.style[prop];
  };
  const expectInset = (d: HTMLElement, padLeft: string) => {
    expect(d.style.left).toBe(css("left", `calc(${padLeft} + 60px)`));
    expect(d.style.left).toContain("60px");
    expect(d.style.right).toBe(css("right", ZEN_LIST_CONTENT_INSET));
    expect(d.style.background).toMatch(/#8e8e93|rgb\(142, 142, 147\)/);
    expect(d.style.transform).toBe("scaleY(.5)");
  };

  it("Home: a hairline under every row but the last, inset to the text column", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("alpha", HOST), workspaceId: "pa", label: "alpha" });
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
    h.addRow(h.selectedId, { address: homeAddress("alpha/2", HOST), workspaceId: "pa", label: "alpha 2" });
    mount();
    goHome();
    const rows = Array.from(screen.getByTestId("home-list").querySelectorAll<HTMLElement>("[data-home-row]"));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).queryAllByTestId("row-divider").length)).toEqual([1, 1, 0]);
    expectInset(within(rows[0]).getByTestId("row-divider"), ZEN_LIST_CONTENT_INSET);
  });

  it("Home: in Rearrange the divider starts after the grip room too", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, { address: homeAddress("alpha", HOST), workspaceId: "pa", label: "alpha" });
    h.addRow(h.selectedId, { address: homeAddress("bravo", HOST), workspaceId: "pb", label: "bravo" });
    mount();
    goHome();
    fireEvent.contextMenu(screen.getByTestId("home-row-alpha"));
    fireEvent.click(screen.getByTestId("menu-rearrange"));
    const d = within(screen.getByTestId("home-list")).getByTestId("row-divider");
    expectInset(d, rearrangePadLeft(ZEN_LIST_CONTENT_INSET, true));
  });

  it("Agents: a hairline under every row but the last; none in the pin grid", () => {
    mount();
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-agent-row]"));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => within(r).queryAllByTestId("row-divider").length)).toEqual([
      ...rows.slice(1).map(() => 1),
      0,
    ]);
    expectInset(within(rows[0]).getByTestId("row-divider"), ZEN_LIST_CONTENT_INSET);
    expect(within(screen.getByTestId("chats-pins")).queryAllByTestId("row-divider")).toHaveLength(0);
  });
});
