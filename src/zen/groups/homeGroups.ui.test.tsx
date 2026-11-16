// @vitest-environment jsdom
// Home groups on the phone (K2 0.46.13, brief §1.5/§1.6): the group bar
// above the search bar, the Groups sheet (list → group page), and the
// swipe between groups — which never starts in the back gesture's left
// edge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/client", () => ({
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
vi.mock("../../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));
vi.mock("../gardens/gardensApi", async (orig) => ({
  ...(await orig<typeof import("../gardens/gardensApi")>()),
  fetchGardenFeed: vi.fn(),
  gardensAvailable: () => false,
}));
vi.mock("../../lib/revive", () => ({ connectServer: vi.fn(async () => "still-valid") }));
vi.mock("../../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => ({ username: "u", owner: true, role: "owner" }),
}));

import { useServersStore } from "../../stores/servers";
import { ChatsList } from "../ChatsList";
import { LIST_TAB_KEY, useHomesStore } from "../homes";
import { useMultiServerPrefs } from "../multi/prefs";
import { FOCUS_OFF } from "../serverPins";
import { useZenStore } from "../zenStore";
import { HOLD_MENU_MS } from "../useHoldMenu";
import { EDGE_ARM_PX } from "../../lib/swipeBack";
import { useGroupsSheet } from "./groupsSheetStore";
import { GLIDE_MAX_MS, GLIDE_MIN_MS, accentShare, groupSwipeOffset, groupSwipeRelease } from "./groupSwipe";
import { RENAME_FAILED_TEXT } from "./GroupsSheet";

const HOST = "example.k2.dev";
const LA = { id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" as const };
const LB = { id: "/b", name: "bravo", initial: "B", path: "/b", addr: "bravo", kind: "agent" as const };

const st = () => useHomesStore.getState();
const at = (x: number, y = 300) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });

function swipe(el: HTMLElement, from: number, to: number) {
  fireEvent.touchStart(el, at(from));
  fireEvent.touchMove(el, at(from + Math.sign(to - from) * 20));
  fireEvent.touchMove(el, at(to));
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: to, clientY: 300 }] });
  act(() => {
    vi.advanceTimersByTime(GLIDE_MAX_MS + GLIDE_MIN_MS + 50);
  });
}

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  useMultiServerPrefs.setState({ multiServer: false });
  localStorage.clear();
  localStorage.setItem(LIST_TAB_KEY, "home");
  useHomesStore.getState().reload();
  useGroupsSheet.setState({ open: null });
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: `https://${HOST}`, username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useZenStore.setState({
    agentSource: "stub",
    agents: [LA, LB],
    screen: "list",
    agentId: "",
    pinnedIds: [],
    serverProjects: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
  });
  // Three groups: Group 1 (alpha), Studio (rocket, bravo), Group 2.
  st().ensureSeeded();
  const g1 = st().selectedId;
  st().addRow(g1, { address: `alpha::${HOST}`, workspaceId: null, label: "alpha" });
  const g2 = st().createGroup();
  st().renameGroup(g2, "Studio");
  st().setHomeIcon(g2, "rocket");
  st().addRow(g2, { address: `bravo::${HOST}`, workspaceId: null, label: "bravo" });
  st().createGroup();
  st().selectHome(g1);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the swipe's rules", () => {
  it("commits past 33% or on a flick, never where there is no group; a third as far past the ends", () => {
    const both = { prev: true, next: true };
    expect(groupSwipeRelease(-140, 0, 400, both)).toEqual({ outcome: "commit", direction: "next" });
    expect(groupSwipeRelease(-120, 0, 400, both).outcome).toBe("cancel");
    expect(groupSwipeRelease(-40, -0.8, 400, both).outcome).toBe("commit");
    expect(groupSwipeRelease(-200, 0.8, 400, both).outcome).toBe("cancel");
    expect(groupSwipeRelease(300, 0, 400, { prev: false, next: true }).outcome).toBe("cancel");
    expect(groupSwipeOffset(90, 400, { prev: false, next: true })).toBe(30);
    expect(groupSwipeOffset(-90, 400, { prev: false, next: true })).toBe(-90);
  });

  it("the accent moves from the current icon to the target as the swipe goes", () => {
    const sw = { progress: 0.25, direction: "next" as const };
    expect(accentShare(1, 1, 3, sw)).toBe(0.75);
    expect(accentShare(2, 1, 3, sw)).toBe(0.25);
    expect(accentShare(0, 1, 3, sw)).toBe(0);
    expect(accentShare(1, 1, 3, null)).toBe(1);
    // No wrap: past the last group the current keeps it.
    expect(accentShare(2, 2, 3, sw)).toBe(1);
  });
});

describe("the group bar", () => {
  it("one glyph per group above the search bar: the current in the accent, an icon or the number", () => {
    mount();
    const bar = screen.getByTestId("home-group-bar");
    expect(bar.getAttribute("aria-label")).toBe("Groups");
    const items = [0, 1, 2].map((i) => screen.getByTestId(`group-bar-item-${i}`));
    expect(items[0].getAttribute("aria-label")).toBe("Group 1, current group");
    expect(items[0].getAttribute("aria-current")).toBe("true");
    expect(items[1].querySelector("[data-group-icon=rocket]")).not.toBeNull();
    expect(items[0].querySelector("[data-group-numeral='1']")).not.toBeNull();
    const ink = screen.getByTestId("group-bar-current-ink");
    expect(ink.style.color).toBe("var(--color-accent-text)");
    expect(ink.style.opacity).toBe("1");
  });

  it("tap selects (this phone only); a long press opens the Groups sheet on that group", () => {
    mount();
    fireEvent.click(screen.getByTestId("group-bar-item-1"));
    expect(st().homes[1].id).toBe(st().selectedId);
    expect(screen.getByTestId("chats-title-home").textContent).toContain("Studio");
    const item = screen.getByTestId("group-bar-item-2");
    fireEvent.pointerDown(item, { clientX: 10, clientY: 10, button: 0 });
    act(() => {
      vi.advanceTimersByTime(HOLD_MENU_MS + 10);
    });
    fireEvent.pointerUp(item);
    fireEvent.click(item);
    // The hold's release didn't also select it.
    expect(st().selectedId).toBe(st().homes[1].id);
    expect(screen.getByTestId("groups-sheet")).not.toBeNull();
    expect((screen.getByTestId("group-name-input") as HTMLInputElement).value).toBe("Group 2");
  });
});

describe("swiping between groups", () => {
  it("a sideways swipe inside the list goes to the next group and back; no wrap", () => {
    mount();
    const list = screen.getByTestId("chats-list");
    const ids = st().homes.map((h) => h.id);
    swipe(list, 600, 150);
    expect(st().selectedId).toBe(ids[1]);
    swipe(list, 600, 150);
    expect(st().selectedId).toBe(ids[2]);
    swipe(list, 600, 150);
    expect(st().selectedId).toBe(ids[2]);
    swipe(list, 150, 600);
    expect(st().selectedId).toBe(ids[1]);
  });

  it("a touch that starts in the left edge is the back gesture's, never a group swipe", () => {
    mount();
    const list = screen.getByTestId("chats-list");
    const first = st().selectedId;
    swipe(list, EDGE_ARM_PX - 4, 600);
    expect(st().selectedId).toBe(first);
    swipe(list, EDGE_ARM_PX - 4, 2);
    expect(st().selectedId).toBe(first);
    // Just past the edge, the same swipe is a group swipe.
    swipe(list, EDGE_ARM_PX + 300, 2);
    expect(st().selectedId).toBe(st().homes[1].id);
  });

  it("on the bar a swipe arms anywhere, even at the edge", () => {
    mount();
    swipe(screen.getByTestId("home-group-bar"), 2, 900);
    expect(st().selectedId).toBe(st().homes[0].id);
    swipe(screen.getByTestId("home-group-bar"), 900, 2);
    expect(st().selectedId).toBe(st().homes[1].id);
  });

  it("a vertical drag is the list's scroll", () => {
    mount();
    const list = screen.getByTestId("chats-list");
    const first = st().selectedId;
    fireEvent.touchStart(list, at(300, 300));
    fireEvent.touchMove(list, at(305, 360));
    fireEvent.touchMove(list, at(100, 400));
    fireEvent.touchEnd(list, { touches: [], changedTouches: [] });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(st().selectedId).toBe(first);
  });
});

describe("the Groups sheet", () => {
  function openList() {
    mount();
    fireEvent.click(screen.getByTestId("chats-title-home"));
    fireEvent.click(screen.getByTestId("home-menu-groups"));
  }

  it("lists the groups; New group makes the next Group N and opens it", () => {
    openList();
    expect(screen.getByTestId("groups-row-1").textContent).toContain("Studio");
    fireEvent.click(screen.getByTestId("groups-new"));
    expect(st().homes.map((h) => h.name)).toEqual(["Group 1", "Studio", "Group 2", "Group 3"]);
    expect((screen.getByTestId("group-name-input") as HTMLInputElement).value).toBe("Group 3");
  });

  it("renames live; an emptied name saves as the next Group N; a failed save keeps the text with Try again", () => {
    openList();
    fireEvent.click(screen.getByTestId("groups-row-1"));
    const input = screen.getByTestId("group-name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Lab" } });
    expect(st().homes[1].name).toBe("Lab");
    fireEvent.change(input, { target: { value: "" } });
    expect(st().homes[1].name).toBe("Group 3");
    expect(input.placeholder).toBe("Group 3");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "k2.homes.v1") throw new Error("quota");
      return orig.call(this, k, v);
    };
    try {
      fireEvent.change(input, { target: { value: "Kept" } });
      expect(screen.getByTestId("group-name-error").textContent).toContain(RENAME_FAILED_TEXT);
      expect(input.value).toBe("Kept");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    } finally {
      Storage.prototype.setItem = orig;
    }
    fireEvent.click(screen.getByTestId("group-name-retry"));
    expect(screen.queryByTestId("group-name-error")).toBeNull();
  });

  it("icon by name: picking sets it and remembers it under Recent; No icon clears it", () => {
    openList();
    fireEvent.click(screen.getByTestId("groups-row-0"));
    fireEvent.change(screen.getByTestId("group-icon-query"), { target: { value: "rock" } });
    fireEvent.click(screen.getByTestId("group-icon-rocket"));
    expect(st().homes[0].icon).toBe("rocket");
    fireEvent.change(screen.getByTestId("group-icon-query"), { target: { value: "" } });
    expect(screen.getByTestId("group-icon-recent-rocket").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("group-icon-grid").querySelectorAll("button")).toHaveLength(244);
    fireEvent.click(screen.getByTestId("group-icon-none-cell"));
    expect(st().homes[0].icon).toBeUndefined();
  });

  it("Most recent at the top is a switch on the group", () => {
    openList();
    fireEvent.click(screen.getByTestId("groups-row-1"));
    fireEvent.click(screen.getByTestId("group-recent-first").querySelector("button")!);
    expect(st().homes[1].recentFirst).toBe(true);
  });

  it("delete is confirmed once; Undo brings it back in place with the same id until the sheet closes", () => {
    openList();
    const studio = st().homes[1];
    st().selectHome(studio.id);
    fireEvent.click(screen.getByTestId("groups-row-1"));
    fireEvent.click(screen.getByTestId("group-delete"));
    fireEvent.click(screen.getByTestId("group-delete-yes"));
    expect(st().homes.map((h) => h.name)).toEqual(["Group 1", "Group 2"]);
    expect(st().selectedId).toBe(st().homes[0].id);
    expect(screen.getByTestId("groups-undo").textContent).toContain("Studio deleted.");
    fireEvent.click(screen.getByTestId("groups-undo-button"));
    expect(st().homes.map((h) => h.id)[1]).toBe(studio.id);
    expect(st().homes[1]).toMatchObject({ icon: "rocket", rows: [expect.objectContaining({ address: `bravo::${HOST}` })] });
    expect(st().selectedId).toBe(studio.id);
    expect(screen.getByTestId("groups-notice").textContent).toBe("Studio is back, with its agents.");
  });

  it("the last group can't be deleted, and says why", () => {
    for (const h of st().homes.slice(1)) st().deleteHome(h.id);
    openList();
    fireEvent.click(screen.getByTestId("groups-row-0"));
    expect((screen.getByTestId("group-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("group-delete-why").textContent).toBe("The last group can’t be deleted.");
  });
});
