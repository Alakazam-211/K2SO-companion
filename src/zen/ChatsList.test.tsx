// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useMultiServerPrefs } from "./multi/prefs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  inspectProjectsSummary: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
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
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(async () => "still-valid"),
}));

import {
  assignFocusGroup,
  createFocusGroup,
  getAppSettings,
  getCliProjectsList,
  getFocusGroupsList,
  reorderProjects,
  setProjectPinned,
} from "../api/client";
import type { FeedbackListRow } from "../api/feedbackPure";
import { useFeedbackStore } from "../stores/feedback";
import { hostLabel, useServersStore } from "../stores/servers";
import {
  ChatsList,
  ZEN_LIST_CONTENT_INSET,
  ZEN_LIST_EDGE_INSET,
  ZEN_LIST_EDGE_PAD,
  ZEN_PIN_AVATAR_PX,
  ZEN_PIN_COL_GAP,
  ZEN_PIN_GRID_BOTTOM_PX,
  zenPinGridColumns,
  zenPinnedGroupInsetPx,
} from "./ChatsList";
import { __resetViewportForTests } from "../lib/useViewportHeight";

/** A CSS length as jsdom normalises it (calc() gets rewritten). */
function cssLen(v: string): string {
  const el = document.createElement("div");
  el.style.left = v;
  return el.style.left;
}

/** Evaluate the inset calc() for a list `w` px wide (100% = w). */
function evalInsetPx(css: string, w: number): number {
  const expr = css.replace(/calc/g, "").replace(/100%/g, String(w)).replace(/px/g, "");
  expect(expr).toMatch(/^[\d\s.+\-*/()]+$/);
  return Function(`return (${expr});`)() as number;
}
import { SEARCH_BAR_REST_BOTTOM } from "./GlassSearchBar";
import { JOIN_NO_PROJECT } from "./agentRow";
import { STUB_AGENTS } from "./stubData";
import { OWNER_LIST_HOLD, useZenStore } from "./zenStore";
import { dragGrip, holdOpen, menuLabels, tap as tapItem } from "../test/rearrangeDrag";
import { FOCUS_OFF, type ServerProject } from "./serverPins";
import { useRecentFirstStore } from "./recentFirst";

/** Two workspaces the server can pin, and one sidecar of the first. */
const LA = { id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" as const };
const LB = { id: "/b", name: "bravo", initial: "B", path: "/b", addr: "bravo", kind: "agent" as const };
const LC = { id: "/c", name: "charlie", initial: "C", path: "/c", addr: "charlie", kind: "agent" as const };
const LIVE_ROWS = [LA, LB, LC];
function project(id: string, handle: string, extra: Partial<ServerProject> = {}): ServerProject {
  return { id, name: handle, path: `/${handle[0]}`, handle, pinned: false, tabOrder: 0, focusGroupId: null, ...extra };
}
const PROJECTS: ServerProject[] = [
  project("pa", "alpha", { tabOrder: 0 }),
  project("pb", "bravo", { tabOrder: 1 }),
  project("pc", "charlie", { tabOrder: 2 }),
];

const SEEDED_SERVER = {
  id: "s1",
  nickname: "test",
  url: "https://example.k2.dev",
  username: "u",
  rememberPassword: false,
};

afterEach(() => {
  cleanup();
  useZenStore.setState({ hiddenSidecarAddrs: [] });
});

beforeEach(() => {
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
  seedServer();
  useZenStore.setState({
    pinnedIds: [],
    hiddenSidecarAddrs: [],
    serverProjects: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    pinError: null,
  });
  vi.mocked(setProjectPinned).mockClear();
  vi.mocked(reorderProjects).mockClear();
});

function seedServer() {
  useServersStore.setState({
    servers: [SEEDED_SERVER],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
}

function ticketRow(id: string, status: string, assignees: string[]) {
  return {
    id,
    projectId: "p1",
    sessionId: null,
    sessionKind: null,
    agentName: null,
    kind: "question",
    title: id,
    body: "",
    options: null,
    priority: 2,
    status,
    answer: null,
    createdAt: 0,
    updatedAt: 0,
    answeredAt: null,
    commentCount: 0,
    assignees,
  } as unknown as FeedbackListRow;
}

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

describe("ChatsList", () => {
  it("zero stored servers is the overlay Add server form, not /login or stub chats", () => {
    useServersStore.setState({
      servers: [],
      activeServerId: null,
      hydrated: true,
    });
    mount();
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.getByText("Add server")).not.toBeNull();
    expect(screen.queryByTestId("chats-home")).toBeNull();
  });

  it("zero-server then a stored server then zero again does not throw (same hook order)", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentError: null,
      screen: "list",
    });
    useServersStore.setState({
      servers: [],
      activeServerId: null,
      hydrated: true,
    });
    mount();
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    act(() => {
      seedServer();
    });
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    act(() => {
      useServersStore.setState({
        servers: [],
        activeServerId: null,
      });
    });
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.queryByTestId("chats-home")).toBeNull();
  });

  it("is the overlay home: Agents title, search, stub rows; no empty pin tray", () => {
    seedServer();
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
    expect(screen.queryByText("Chats")).toBeNull();
    // No pins: no tray, no placeholder; the list starts under the header.
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    expect(screen.queryByTestId("chats-pin-drop")).toBeNull();
    expect(screen.getByTestId("chats-home").textContent).not.toMatch(/Drop here/);
    expect(screen.getByTestId("chats-home").textContent).not.toMatch(/Hold a pin/);
    expect(screen.getByTestId("chats-home").textContent).not.toMatch(/Hold a chat/);
    expect(screen.getByPlaceholderText("Search")).not.toBeNull();
    const home = screen.getByTestId("chats-home");
    expect(home.style.position).toBe("fixed");
    const column = screen.getByTestId("chats-column");
    expect(column.style.height).toBe(`${window.innerHeight}px`);
    expect(column.className).toMatch(/relative/);
    expect(
      screen.getByPlaceholderText("Search").closest("[data-testid=chats-column]")
    ).not.toBeNull();
    expect(screen.getByPlaceholderText("Search").closest("label")?.className).toMatch(
      /zen-glass/
    );
    expect(screen.getByRole("button", { name: "Settings" }).className).toMatch(/zen-glass/);
    expect(screen.getByLabelText(/STUB \[STUB\] not-a-real-agent-1/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "New workspace" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Tickets" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Server / })).not.toBeNull();
    expect(screen.queryByTestId("tickets-badge")).toBeNull();
  });

  it("header: server button on the left, Projects, Tickets then the settings cog on the right, all 34px", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    const header = screen.getByRole("heading", { name: "Agents" }).closest("header")!;
    const row = screen.getByTestId("chats-header-row");
    expect(header.contains(row)).toBe(true);
    const serverBtn = screen.getByRole("button", { name: /Server / });
    expect(row.firstElementChild).toBe(serverBtn);
    expect(serverBtn.querySelector("[data-testid=server-icon]")).toBeNull();
    expect(serverBtn.querySelector("[data-testid=server-status-dot]")).not.toBeNull();

    const right = screen.getByTestId("chats-header-right");
    const cog = screen.getByRole("button", { name: "Settings" });
    expect(right.contains(cog)).toBe(true);
    expect(cog.textContent).toBe("");
    expect(cog.querySelector("[data-testid=settings-icon]")?.getAttribute("data-k2-icon")).toBe("cog");
    const rightButtons = Array.from(right.children);
    const projects = screen.getByRole("button", { name: "Projects" });
    expect(rightButtons).toEqual([projects, screen.getByRole("button", { name: "Tickets" }), cog]);
    // Desktop Garden nav rail Projects glyph (DashboardIcon), ticket stroke.
    const icon = projects.querySelector("[data-testid=projects-icon]")!;
    expect(icon.getAttribute("stroke-width")).toBe("1.7");
    expect(icon.querySelectorAll("rect")).toHaveLength(4);
    expect(projects.style.width).toBe("34px");
    expect(projects.style.height).toBe("34px");
    expect(projects.className).toMatch(/zen-glass-pill/);
    expect(screen.queryByTestId("projects-badge")).toBeNull();

    expect(serverBtn.style.height).toBe("34px");
    expect(serverBtn.className).toMatch(/zen-glass-pill/);
    expect(cog.style.width).toBe("34px");
    expect(cog.style.height).toBe("34px");
    expect(cog.className).toMatch(/zen-glass-pill/);
    fireEvent.click(cog);
    expect(screen.getByTestId("overlay-settings")).not.toBeNull();
  });

  it("header floats over the list with the chat header's progressive blur", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      lastAtByKey: {},
      agentError: null,
      screen: "list",
      pinnedIds: [LA.id],
    });
    mount();
    const header = screen.getByTestId("chats-header");
    expect(header.className).toMatch(/absolute/);
    expect(header.style.pointerEvents).toBe("none");
    // Below the Settings / Tickets / Servers overlays (zIndex 6).
    expect(Number(header.style.zIndex)).toBeLessThan(6);

    const blur = screen.getByTestId("chats-header-blur");
    expect(header.contains(blur)).toBe(true);
    // Agents-only modifier: the blur starts a little before the header.
    expect(blur.className).toBe("zen-header-blur zen-header-blur--early");
    expect(blur.getAttribute("aria-hidden")).not.toBeNull();
    expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
    expect(blur.querySelector(".zen-header-tint")).not.toBeNull();

    // Only the controls take touches.
    expect(screen.getByTestId("chats-header-server").style.pointerEvents).toBe("auto");
    expect(screen.getByTestId("chats-header-right").style.pointerEvents).toBe("auto");

    // The list (pins grid included) starts under the header: safe area plus
    // the measured header height (jsdom measures 0, so the resting 64px).
    const list = screen.getByTestId("chats-list");
    expect(header.contains(list)).toBe(false);
    expect(list.style.paddingTop).toMatch(/env\(safe-area-inset-top\)/);
    expect(list.style.paddingTop).toMatch(/64px/);
    expect(list.contains(screen.getByTestId("chats-pins"))).toBe(true);

    // At rest the strip below the header is off, so the first row is
    // sharp; once the list scrolls the early blur reaches below the header.
    expect(blur.dataset.scrolled).toBeUndefined();
    list.scrollTop = 40;
    fireEvent.scroll(list);
    expect(blur.dataset.scrolled).toBe("1");
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(blur.dataset.scrolled).toBeUndefined();
  });

  it("list rows follow Settings → Text Size (--zen-text-scale)", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    const name = screen.getAllByTestId("row-name")[0];
    expect(name.textContent).toBe(LA.name);
    expect(name.getAttribute("style")).toContain("calc(16px * var(--zen-text-scale");
    expect(name.className).toMatch(/truncate/);
    expect(name.className).toMatch(/min-w-0/);
    const preview = screen.getAllByTestId("row-preview")[0];
    expect(preview.getAttribute("style")).toContain("calc(14px * var(--zen-text-scale");
    expect(preview.className).toMatch(/truncate/);
    const when = screen.getAllByTestId("row-when")[0];
    expect(when.getAttribute("style")).toContain("calc(14px * var(--zen-text-scale");
    // Header chrome stays unscaled.
    expect(screen.getByTestId("chats-title").getAttribute("style") ?? "").not.toContain(
      "zen-text-scale"
    );
    expect(screen.getByTestId("server-name").getAttribute("style") ?? "").not.toContain(
      "zen-text-scale"
    );
  });

  it("header server pill shows the nickname with the status dot before it", () => {
    useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list" });
    mount();
    const serverBtn = screen.getByRole("button", { name: "Server test" });
    expect(serverBtn.getAttribute("title")).toBe("test");
    expect(serverBtn.getAttribute("data-testid")).toBe("chats-header-server");
    const name = screen.getByTestId("server-name");
    expect(serverBtn.contains(name)).toBe(true);
    expect(name.textContent).toBe("test");
    const dot = screen.getByTestId("server-status-dot");
    expect(serverBtn.firstElementChild).toBe(dot);
    expect(dot.style.width).toBe("8px");
    expect(dot.getAttribute("style")).toMatch(/#22c55e|rgb\(34,\s*197,\s*94\)/);
  });

  it("a long nickname is truncated inside a width-capped pill", () => {
    const nickname = "my-very-long-production-server-nickname";
    useServersStore.setState({ servers: [{ ...SEEDED_SERVER, nickname }] });
    useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list" });
    mount();
    const serverBtn = screen.getByRole("button", { name: `Server ${nickname}` });
    expect(serverBtn.style.maxWidth).toBe("124px");
    expect(serverBtn.className).toMatch(/min-w-0/);
    const name = screen.getByTestId("server-name");
    expect(name.textContent).toBe(nickname);
    expect(name.className).toMatch(/\btruncate\b/);
  });

  it("no nickname falls back to the host label", () => {
    useServersStore.setState({ servers: [{ ...SEEDED_SERVER, nickname: "" }] });
    useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list" });
    mount();
    const host = hostLabel(SEEDED_SERVER.url);
    expect(host).not.toBe("");
    expect(screen.getByRole("button", { name: `Server ${host}` })).not.toBeNull();
    expect(screen.getByTestId("server-name").textContent).toBe(host);
  });

  it("no active server shows Servers with a grey dot", () => {
    useServersStore.setState({ activeServerId: null });
    useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list" });
    mount();
    const serverBtn = screen.getByRole("button", { name: "Server Servers" });
    expect(screen.getByTestId("server-name").textContent).toBe("Servers");
    expect(serverBtn.getAttribute("title")).toBe("Servers");
    expect(screen.getByTestId("server-status-dot").getAttribute("style")).toMatch(
      /#8e8e93|rgb\(142,\s*142,\s*147\)/
    );
  });

  it("the ticket icon shows waiting-on-me in amber and opens the ticket tray", () => {
    seedServer();
    // Server user "u": two waiting on me, one waiting on bob, one unassigned.
    useFeedbackStore.setState({
      rows: [
        ticketRow("a", "waiting", ["u"]),
        ticketRow("b", "waiting", ["U"]),
        ticketRow("c", "waiting", ["bob"]),
        ticketRow("d", "waiting", []),
        ticketRow("e", "answered", ["u"]),
      ],
      isLoading: false,
      error: null,
    });
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    const badge = screen.getByTestId("tickets-badge");
    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("data-tone")).toBe("mine");
    expect(badge.style.background).toMatch(/#f59e0b|rgb\(245,\s*158,\s*11\)/);
    fireEvent.click(
      screen.getByRole("button", { name: "Tickets, 2 waiting on you, 4 waiting in all" })
    );
    expect(screen.getByTestId("overlay-tickets")).not.toBeNull();
  });

  it("nothing waiting on me: the badge falls back to the All count, still amber", () => {
    seedServer();
    useFeedbackStore.setState({
      rows: [ticketRow("c", "waiting", ["bob"]), ticketRow("d", "waiting", [])],
      isLoading: false,
      error: null,
    });
    useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list" });
    mount();
    const badge = screen.getByTestId("tickets-badge");
    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("data-tone")).toBe("others");
    expect(badge.style.background).toMatch(/#f59e0b|rgb\(245,\s*158,\s*11\)/);
    expect(badge.style.color).toMatch(/#000|rgb\(0,\s*0,\s*0\)/);
    expect(
      screen.getByRole("button", { name: "Tickets, none waiting on you, 2 waiting in all" })
    ).not.toBeNull();
  });

  it("opening a row switches the store to the thread screen", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentId: "",
    });
    mount();
    fireEvent.click(screen.getByLabelText(/STUB \[STUB\] not-a-real-agent-2/));
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useZenStore.getState().agentId).toBe(STUB_AGENTS[1].id);
  });

  it("Settings opens the Zen settings sheet (no Leave Zen Mode); Done closes", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("overlay-settings")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Leave Zen Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Terminal view/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Current app/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("overlay-settings")).toBeNull();
  });

  it("signed-in unconfirmed list is honest and empty, not stub", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentError: OWNER_LIST_HOLD,
      screen: "list",
    });
    mount();
    const empty = screen.getByTestId("chats-empty").textContent ?? "";
    expect(empty).toMatch(/No agents on this list/);
    expect(empty).toMatch(/does not invent a mapping/);
    expect(empty).toMatch(/skills enumerator/);
    expect(screen.queryByText("[STUB] not-a-real-agent-1")).toBeNull();
  });

  it("live rows without addr say so and do not claim a conversation", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: null,
          joinMiss: JOIN_NO_PROJECT,
        },
        {
          id: "/ws2",
          name: "Skin Test A",
          initial: "ST",
          path: "/ws2",
          addr: null,
          joinMiss: JOIN_NO_PROJECT,
        },
      ],
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText(`appa, ${JOIN_NO_PROJECT}`)).not.toBeNull();
    expect(screen.getByLabelText(`Skin Test A, ${JOIN_NO_PROJECT}`)).not.toBeNull();
    expect(screen.getAllByText(JOIN_NO_PROJECT).length).toBe(2);
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.getAllByTestId("row-when").length).toBe(2);
  });

  it("centers the pin image over the name", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          color: "#22c55e",
          iconUrl: "https://example.k2.dev/appa.png",
        },
      ],
      pinnedIds: ["/ws"],
      agentError: null,
      screen: "list",
    });
    mount();
    const wrap = screen.getByTestId("pin-avatar");
    expect(wrap.className).toMatch(/justify-center/);
    const img = wrap.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.k2.dev/appa.png");
    expect(img?.getAttribute("style") || "").toMatch(/object-position:\s*center/i);
  });

  it("paints the desktop workspace colour on the row avatar", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          color: "#22c55e",
        },
      ],
      agentError: null,
      screen: "list",
    });
    mount();
    const row = screen.getByLabelText("appa");
    const avatar = row.querySelector("span > span");
    expect(avatar?.getAttribute("style") || "").toMatch(/rgb\(34, 197, 94\)|#22c55e/);
  });

  it("pulses a busy agent and shows its counts in place of the preview", () => {
    const original = useZenStore.getState().refreshActivity;
    onTestFinished(() =>
      useZenStore.setState({ refreshActivity: original, activity: { byPath: {}, bySession: {} } })
    );
    const refreshActivity = vi.fn(async () => {});
    useZenStore.setState({
      agentSource: "live",
      agents: [
        { id: "/ws", name: "appa", initial: "A", path: "/ws", addr: "appa" },
        { id: "/quiet", name: "quiet", initial: "Q", path: "/quiet", addr: "quiet" },
      ],
      agentError: null,
      screen: "list",
      refreshActivity,
      activity: {
        byPath: {
          "/ws": { display: "working", counts: { subagents: 1, tools: 14, commands: 5 } },
          "/quiet": { display: "idle", counts: { subagents: 0, tools: 0, commands: 0 } },
        },
        bySession: {},
      },
    });
    mount();
    expect(refreshActivity).toHaveBeenCalled();
    const row = screen.getByLabelText("appa, Working · 1 subagent · 14 tools · 5 commands");
    expect(row.querySelector('[data-testid="row-activity-dot"]')?.className).toContain("k2-pulse");
    expect(row.querySelector('[data-testid="row-activity"]')?.textContent).toBe(
      "Working · 1 subagent · 14 tools · 5 commands"
    );
    const quiet = screen.getByLabelText("quiet");
    expect(quiet.querySelector('[data-testid="row-activity-dot"]')).toBeNull();
    expect(quiet.querySelector('[data-testid="row-preview"]')).not.toBeNull();
  });

  it("does not poll agent status while a Thread covers the list", () => {
    const original = useZenStore.getState().refreshActivity;
    onTestFinished(() => useZenStore.setState({ refreshActivity: original, screen: "list" }));
    const refreshActivity = vi.fn(async () => {});
    useZenStore.setState({
      agentSource: "live",
      agents: [{ id: "/ws", name: "appa", initial: "A", path: "/ws", addr: "appa" }],
      agentError: null,
      screen: "thread",
      refreshActivity,
    });
    mount();
    expect(refreshActivity).not.toHaveBeenCalled();
    act(() => useZenStore.setState({ screen: "list" }));
    expect(refreshActivity).toHaveBeenCalledTimes(1);
  });

  it("press and hold a row: its menu pins it; a pin dragged out of the grid stays pinned", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      serverProjects: PROJECTS,
      agentError: null,
      screen: "list",
      agentId: "",
      pinnedIds: [],
    });
    mount();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    const row = screen.getByLabelText("alpha");
    // Long-press must not select text.
    expect(row.style.userSelect).toBe("none");
    holdOpen(row);
    // The hold's own click did not open the chat.
    expect(useZenStore.getState().screen).toBe("list");
    const menu = screen.getByTestId("row-menu");
    expect(menu.className).toMatch(/zen-glass/);
    expect(menu.getAttribute("role")).toBe("menu");
    // Groups off, no read state: Open, Pin, Rearrange.
    expect(menuLabels(menu)).toEqual(["Open", "Pin", "Rearrange"]);
    // Nothing lifts: no ghost, no drop strip, the list still scrolls.
    expect(screen.queryByTestId("pin-ghost")).toBeNull();
    expect(screen.queryByTestId("chats-pin-drop")).toBeNull();
    expect(screen.getByTestId("chats-list").style.touchAction).toBe("");
    tapItem(screen.getByTestId("menu-pin"));
    expect(screen.queryByTestId("row-menu")).toBeNull();
    // Server pin: projects/update {id, pinned: 1}.
    expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", true);
    expect(reorderProjects).not.toHaveBeenCalled();
    expect(useZenStore.getState().pinnedIds).toEqual(["/a"]);
    expect(screen.getByLabelText("Pinned alpha")).not.toBeNull();
    expect(screen.queryByLabelText("alpha")).toBeNull();

    // A pin dragged below the grid snaps back: Unpin is in its menu.
    screen.getByTestId("chats-pins").getBoundingClientRect = () =>
      ({ left: 0, right: 300, top: 0, bottom: 90, width: 300, height: 90, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    fireEvent.pointerDown(screen.getByLabelText("Pinned alpha"), { clientX: 40, clientY: 40, button: 0, pointerId: 2 });
    fireEvent.pointerMove(screen.getByTestId("chats-home"), { clientX: 40, clientY: 400, pointerId: 2 });
    expect(screen.getByTestId("pin-ghost")).not.toBeNull();
    fireEvent.pointerUp(screen.getByTestId("chats-home"), { clientX: 40, clientY: 400, pointerId: 2 });
    expect(screen.queryByTestId("pin-ghost")).toBeNull();
    expect(setProjectPinned).toHaveBeenCalledTimes(1);
    expect(useZenStore.getState().pinnedIds).toEqual(["/a"]);
  });

  it("no swipe and no hold-drag on rows: a sideways drag or a moved hold does nothing", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      serverProjects: PROJECTS,
      agentError: null,
      screen: "list",
      agentId: "",
      pinnedIds: [],
    });
    mount();
    const row = screen.getByLabelText("alpha");
    expect(document.querySelector("[data-swipe-" + "row]")).toBeNull();
    expect(document.querySelector("[data-swipe-action]")).toBeNull();
    // Sideways: no reveal, no transform.
    fireEvent.pointerDown(row, { clientX: 20, clientY: 200, button: 0, pointerId: 3 });
    fireEvent.pointerMove(row, { clientX: 140, clientY: 202, pointerId: 3 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(row, { clientX: 140, clientY: 202, pointerId: 3 });
    expect(row.style.transform).toBe("");
    // The move dropped the hold: no menu.
    expect(screen.queryByTestId("row-menu")).toBeNull();
    // A vertical pan (the list scrolling) drops it too.
    fireEvent.pointerDown(row, { clientX: 20, clientY: 200, button: 0, pointerId: 4 });
    fireEvent.pointerMove(row, { clientX: 22, clientY: 240, pointerId: 4 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId("row-menu")).toBeNull();
    // The browser taking the touch for a scroll (pointercancel) as well.
    fireEvent.pointerDown(row, { clientX: 20, clientY: 200, button: 0, pointerId: 5 });
    fireEvent.pointerCancel(row, { pointerId: 5 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId("row-menu")).toBeNull();
    expect(setProjectPinned).not.toHaveBeenCalled();
    // A plain tap still opens the chat.
    fireEvent.click(row);
    expect(useZenStore.getState().agentId).toBe("/a");
  });

  it("hold-drag a pin onto another pin reorders", () => {
    vi.useFakeTimers();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
    const a = LA;
    const b = LB;
    const projects = PROJECTS.map((p) => (p.id === "pc" ? p : { ...p, pinned: true }));
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      serverProjects: projects,
      agentError: null,
      screen: "list",
      pinnedIds: [a.id, b.id],
    });
    mount();
    const rect = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        top: 10,
        bottom: 90,
        width,
        height: 80,
        x: left,
        y: 10,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const pins = screen.getByTestId("chats-pins");
    pins.getBoundingClientRect = () => rect(0, 300);
    screen.getByLabelText(`Pinned ${a.name}`).getBoundingClientRect = () =>
      rect(10, 80);
    screen.getByLabelText(`Pinned ${b.name}`).getBoundingClientRect = () =>
      rect(110, 80);
    fireEvent.pointerDown(screen.getByLabelText(`Pinned ${b.name}`), {
      clientX: 150,
      clientY: 50,
      button: 0,
      pointerId: 1,
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerMove(screen.getByTestId("chats-home"), {
      clientX: 30,
      clientY: 50,
      pointerId: 1,
    });
    fireEvent.pointerUp(screen.getByTestId("chats-home"), {
      clientX: 30,
      clientY: 50,
      pointerId: 1,
    });
    expect(useZenStore.getState().pinnedIds).toEqual([b.id, a.id]);
    // Pinned ids only, in the new order (desktop Sidebar parity).
    expect(reorderProjects).toHaveBeenCalledWith(expect.anything(), ["pb", "pa"]);
    expect(setProjectPinned).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("orders chats like desktop: the server's project list, not last-message time", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/old",
          name: "older chat",
          initial: "O",
          path: "/old",
          addr: "old",
          joinMiss: null,
          kind: "agent",
        },
        {
          id: "/new",
          name: "newer chat",
          initial: "N",
          path: "/new",
          addr: "new",
          joinMiss: null,
          kind: "agent",
        },
      ],
      // "newer chat" messaged last, but "older chat" is first in the
      // server's project list: desktop's Agents view draws it first.
      lastAtByKey: { "s1|t:old": 10, "s1|t:new": 50 },
      serverProjects: [
        { id: "p-old", path: "/old", handle: "old", name: "older chat", pinned: false, tabOrder: 0, focusGroupId: null },
        { id: "p-new", path: "/new", handle: "new", name: "newer chat", pinned: false, tabOrder: 1, focusGroupId: null },
      ],
      agentError: null,
      screen: "list",
    });
    mount();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const chats = names.filter((n) => n === "older chat" || n === "newer chat");
    expect(chats).toEqual(["older chat", "newer chat"]);
  });

  it("a joined live row describes what it is, with time and a chevron", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/Users/Baden/Appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: { "s1|t:appa": Date.now() / 1000 },
      previewByKey: {
        "s1|t:appa": { at: Date.now() / 1000, seq: 4, mine: false, kind: "text", text: "Tests pass on **main**." },
      },
      ensureLastAt: () => {},
      agentError: null,
      screen: "list",
    });
    onTestFinished(() =>
      useZenStore.setState({ previewByKey: {}, ensureLastAt: useZenStore.getInitialState().ensureLastAt })
    );
    mount();
    expect(screen.getByLabelText("appa, Tests pass on main.")).not.toBeNull();
    expect(screen.queryByText("Thread")).toBeNull();
    const preview = screen.getByTestId("row-preview");
    expect(preview.textContent).toBe("Tests pass on main.");
    expect(preview.querySelector("strong")?.textContent).toBe("main");
    expect(screen.getByTestId("row-when").querySelector("[data-testid=row-chevron]")).not.toBeNull();
    expect(screen.getByTestId("row-when").textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  describe("line two: the main Thread's last message", () => {
    const appa = { id: "/ws", name: "appa", initial: "A", path: "/ws", addr: "appa", kind: "agent" as const };
    const quiet = { id: "/q", name: "quiet", initial: "Q", path: "/q", addr: "quiet", kind: "agent" as const };
    const fresh = { id: "/n", name: "fresh", initial: "F", path: "/n", addr: "fresh", kind: "agent" as const };
    function show(previewByKey: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      const original = useZenStore.getState().refreshActivity;
      onTestFinished(() =>
        useZenStore.setState({
          previewByKey: {},
          refreshActivity: original,
          ensureLastAt: useZenStore.getInitialState().ensureLastAt,
          activity: { byPath: {}, bySession: {} },
        })
      );
      useZenStore.setState({
        agentSource: "live",
        agents: [appa, quiet, fresh],
        agentError: null,
        screen: "list",
        lastAtByKey: {},
        previewByKey: previewByKey as never,
        ensureLastAt: () => {},
        refreshActivity: vi.fn(async () => {}),
        ...extra,
      });
      return mount();
    }

    it("own message gets You:, an agent's none, empty Thread says No messages yet, loading is blank", () => {
      const { container } = show({
        "s1|t:appa": { at: 10, seq: 2, mine: true, kind: "text", text: "ship it" },
        "s1|t:quiet": null,
      });
      const rows = screen.getAllByTestId("row-preview");
      expect(rows[0].textContent).toBe("You: ship it");
      expect(screen.getByLabelText("appa, You: ship it")).not.toBeNull();
      expect(rows[1].textContent).toBe("No messages yet");
      expect(rows[1].querySelector('[data-testid="row-preview-empty"]')).not.toBeNull();
      // Not fetched yet: the line keeps its height, with no text that then jumps.
      expect(rows[2].textContent).toBe("\u00a0");
      expect(screen.getByLabelText("fresh")).not.toBeNull();
      expect(container.textContent?.toLowerCase()).not.toContain("main chat");
    });

    it("choice cards show the prompt; secret cards never their content", () => {
      show({
        "s1|t:appa": { at: 10, seq: 2, mine: false, kind: "choice", text: "Deploy *now*?" },
        "s1|t:quiet": { at: 11, seq: 3, mine: false, kind: "secret", text: "" },
      });
      const rows = screen.getAllByTestId("row-preview");
      expect(rows[0].textContent).toBe("Deploy now?");
      expect(rows[0].querySelector("em")?.textContent).toBe("now");
      expect(rows[1].textContent).toBe("Asked for a secret");
    });

    it("the activity line still replaces the snippet while the agent works", () => {
      show(
        { "s1|t:appa": { at: 10, seq: 2, mine: false, kind: "text", text: "done" } },
        {
          activity: {
            byPath: { "/ws": { display: "working", counts: { subagents: 0, tools: 14, commands: 0 } } },
            bySession: {},
          },
        }
      );
      const row = screen.getByLabelText("appa, Working · 14 tools");
      expect(row.querySelector('[data-testid="row-activity"]')?.textContent).toBe("Working · 14 tools");
      expect(row.querySelector('[data-testid="row-preview"]')).toBeNull();
      expect(row.textContent).not.toContain("done");
    });

    it("the snippet sits in one truncating line", () => {
      show({
        "s1|t:appa": {
          at: 10,
          seq: 2,
          mine: false,
          kind: "text",
          text: "# Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
        },
      });
      const line = screen.getAllByTestId("row-preview")[0];
      expect(line.className).toContain("truncate");
      expect(line.textContent).toBe("Plan one · two [table] const x = 1;");
      expect(line.textContent).not.toContain("\n");
      expect(line.querySelector("strong")?.textContent).toBe("Plan");
      expect(line.querySelector('[data-testid="row-preview-code"]')?.textContent).toBe("const x = 1;");
      expect(line.querySelector("table")).toBeNull();
    });
  });

  it("an empty last-message time is an empty slot next to the chevron", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("row-when").textContent?.replace(/\s/g, "")).toBe("");
    expect(screen.getByTestId("row-when").querySelector("[data-testid=row-chevron]")).not.toBeNull();
  });

  it("a sidecar row keeps the name on line one and the chat title on line two", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws::k2so-companion/1",
          name: "K2 Companion",
          initial: "K",
          path: "/ws",
          addr: "k2so-companion/1",
          chatTitle: "1",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("K2 Companion, 1")).not.toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("1");
    expect(screen.getByTestId("row-preview").textContent).not.toBe("K2 Companion");
  });

  it("a hidden extra chat leaves the list until you search for it", () => {
    const extra = {
      id: "/ws::k2so-companion/1",
      name: "K2 Companion",
      initial: "K",
      path: "/ws",
      addr: "k2so-companion/1",
      chatTitle: "review",
      joinMiss: null,
      kind: "agent" as const,
      mode: "custom",
      enabled: true,
      live: true,
    };
    const main = {
      ...extra,
      id: "/ws::k2so-companion",
      addr: "k2so-companion",
      chatTitle: null,
    };
    useZenStore.setState({
      agentSource: "live",
      agents: [main, extra],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("K2 Companion, review")).not.toBeNull();
    act(() => {
      useZenStore.getState().hideSidecarChat(extra.id);
    });
    expect(screen.queryByLabelText("K2 Companion, review")).toBeNull();
    expect(screen.getByLabelText("K2 Companion")).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "review" },
    });
    expect(screen.getByLabelText("K2 Companion, review")).not.toBeNull();
  });

  it("searching from a scrolled list jumps to the top so the hit is on screen", () => {
    const extra = {
      id: "/ws::k2so-companion/1",
      name: "K2 Companion",
      initial: "K",
      path: "/ws",
      addr: "k2so-companion/1",
      chatTitle: "qa1a5ee",
      joinMiss: null,
      kind: "agent" as const,
      mode: "custom",
      enabled: true,
      live: true,
    };
    const filler = Array.from({ length: 12 }, (_, i) => ({
      id: `/ws::filler-${i}`,
      name: `Filler ${i}`,
      initial: "F",
      path: "/ws",
      addr: `filler-${i}`,
      chatTitle: null,
      joinMiss: null,
      kind: "agent" as const,
      mode: "custom",
      enabled: true,
      live: true,
    }));
    useZenStore.setState({
      agentSource: "live",
      agents: [...filler, extra],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
      hiddenSidecarAddrs: [extra.addr],
    });
    mount();
    const list = screen.getByTestId("chats-list");
    Object.defineProperty(list, "scrollHeight", { value: 2400, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    list.scrollTop = 900;
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "qa1a5ee" },
    });
    expect(list.scrollTop).toBe(0);
    expect(screen.getByLabelText("K2 Companion, qa1a5ee")).not.toBeNull();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
  });

  it("search hides the pin tray so a single hit is not under empty padding", () => {
    const extra = {
      ...STUB_AGENTS[0],
      id: "extra-1",
      name: "Skin Test A",
      addr: "skin-test-a/qa088",
      chatTitle: "qa088",
    };
    useZenStore.setState({
      agentSource: "live",
      agents: [STUB_AGENTS[0], extra],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
      hiddenSidecarAddrs: [extra.addr],
      pinnedIds: [STUB_AGENTS[0].id],
    });
    mount();
    expect(screen.getByTestId("chats-pins")).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "qa088" },
    });
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    expect(screen.getByLabelText("Skin Test A, qa088")).not.toBeNull();
    // Clears the keyboard-up search bar: 44 bar + 8 gap + 8 air.
    expect(screen.getByTestId("chats-list").style.paddingBottom).toBe("60px");
  });

  it("a server with no recovery entry is sign-in required, not connected", () => {
    useServersStore.setState({
      servers: [SEEDED_SERVER],
      activeServerId: "s1",
      hydrated: true,
      tokens: {},
      recovery: {},
    });
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    const serverBtn = screen.getByRole("button", { name: /Server / });
    const headerDot = screen.getByTestId("server-status-dot");
    expect(serverBtn.contains(headerDot)).toBe(true);
    expect(headerDot?.getAttribute("style") || headerDot?.style.background).toMatch(
      /#ef4444|rgb\(239,\s*68,\s*68\)/
    );
    fireEvent.click(serverBtn);
    expect(screen.getByText("sign-in required")).not.toBeNull();
    expect(screen.queryByText("connected")).toBeNull();
  });

  it("the plus button opens the New Workspace sheet, not the old picker", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    expect(screen.queryByRole("button", { name: "New message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByTestId("new-workspace")).not.toBeNull();
    expect(screen.getByText("New Workspace")).not.toBeNull();
    expect(screen.queryByTestId("overlay-compose")).toBeNull();
    fireEvent.click(screen.getByTestId("new-workspace-cancel"));
    expect(screen.queryByTestId("new-workspace")).toBeNull();
  });

  it("Settings has no DEBUG projects-summary", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentError: OWNER_LIST_HOLD,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText(/DEBUG/)).toBeNull();
    expect(screen.queryByTestId("summary-dump")).toBeNull();
  });

  it("project chats are not on the Agents page: not in the list, search or pins", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "group:pg1",
          name: "K2 Companion",
          initial: "K",
          kind: "group",
          groupId: "pg1",
          memberCount: 3,
          addr: null,
          joinMiss: null,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    useZenStore.setState({ pinnedIds: ["group:pg1"] });
    mount();
    expect(screen.queryByLabelText("K2 Companion")).toBeNull();
    expect(screen.queryByText("Project Chat")).toBeNull();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "K2 Comp" } });
    expect(screen.queryByLabelText("K2 Companion")).toBeNull();
    expect(screen.queryByText("K2 Companion")).toBeNull();
  });

  it("the server button opens the overlay server list", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Server / }));
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Servers" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "test" })).not.toBeNull();
  });

  it("Chats and Servers search share the bar: 8px over the keyboard, safe area at rest", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    mount();
    const chatsInput = screen.getByPlaceholderText("Search");
    const chatsBar = chatsInput.closest("[data-no-pin]") as HTMLElement;
    expect(chatsBar.dataset.bottom).toBe(SEARCH_BAR_REST_BOTTOM);
    fireEvent.focus(chatsInput);
    expect(chatsBar.style.bottom).toBe("8px");
    expect(chatsBar.dataset.bottom).toBe("8px");
    fireEvent.blur(chatsInput);

    fireEvent.click(screen.getByRole("button", { name: /Server / }));
    const serversBar = screen.getByTestId("overlay-servers-bar");
    const serversInput = screen.getByTestId("overlay-servers-search");
    expect(serversBar.className).toBe(chatsBar.className);
    expect(serversBar.dataset.bottom).toBe(SEARCH_BAR_REST_BOTTOM);
    fireEvent.focus(serversInput);
    expect(serversBar.style.bottom).toBe("8px");
    expect(serversBar.dataset.bottom).toBe("8px");
  });

  describe("agent menu: Move to group…", () => {
    const A = LA;
    const B = LB;
    const SERVER_GROUPS = [
      { id: "g1", name: "Work", color: "#ff0000", tabOrder: 0, createdAt: 0 },
      { id: "g2", name: "Home", color: null, tabOrder: 1, createdAt: 0 },
    ];
    const GROUPS = [
      { id: "g1", name: "Work", color: "#ff0000" },
      { id: "g2", name: "Home", color: null },
    ];
    let serverGroups: unknown[] = SERVER_GROUPS;

    afterEach(() => {
      vi.useRealTimers();
      serverGroups = SERVER_GROUPS;
      vi.mocked(getAppSettings).mockImplementation(async () => ({ ok: true, data: {} }));
      vi.mocked(getFocusGroupsList).mockImplementation(async () => ({ ok: true, data: [] }));
      vi.mocked(assignFocusGroup).mockImplementation(async () => ({ ok: true, data: {} }));
      vi.mocked(createFocusGroup).mockReset();
      useZenStore.setState({ focus: FOCUS_OFF, focusGroupsEnabled: false });
    });

    /** alpha is in Work; bravo and charlie are ungrouped. Viewing Work. */
    function setup(pinnedIds: string[] = [], { groups = true }: { groups?: boolean } = {}) {
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      localStorage.clear();
      vi.mocked(assignFocusGroup).mockClear();
      vi.mocked(getAppSettings).mockImplementation(async () => ({
        ok: true,
        data: groups ? { focusGroupsEnabled: true, activeFocusGroupId: "g1" } : {},
      }));
      vi.mocked(getFocusGroupsList).mockImplementation(async () => ({ ok: true, data: serverGroups }));
      const pinnedProjects = new Set<string>(pinnedIds.map((id) => (id === LA.id ? "pa" : id === LB.id ? "pb" : "pc")));
      useZenStore.setState({
        agentSource: "live",
        agents: LIVE_ROWS,
        serverProjects: PROJECTS.map((p) => ({
          ...p,
          pinned: pinnedProjects.has(p.id),
          focusGroupId: p.id === "pa" ? "g1" : null,
        })),
        agentError: null,
        screen: "list",
        agentId: "",
        pinnedIds,
        focus: groups ? { enabled: true, currentId: "g1", groups: GROUPS } : FOCUS_OFF,
        focusGroupsEnabled: groups,
      });
      mount();
    }
    type Row = (typeof LIVE_ROWS)[number];
    const row = (a: Row) => screen.getByLabelText(a.name);
    const groupOf = (pid: string) =>
      useZenStore.getState().serverProjects.find((p) => p.id === pid)?.focusGroupId ?? null;
    const flush = () => act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    /** Hold a row (or pin) for its menu. */
    function openMenu(el: HTMLElement) {
      vi.useFakeTimers();
      holdOpen(el);
      vi.useRealTimers();
    }
    /** Hold the row, then Move to group…. */
    function openPicker(a: Row) {
      openMenu(row(a));
      tapItem(screen.getByTestId("menu-group"));
      return screen.getByTestId("group-picker");
    }

    it("a row's menu has Move to group…, in its group's colour", () => {
      setup();
      openMenu(row(A));
      expect(menuLabels(screen.getByTestId("row-menu"))).toEqual(["Open", "Pin", "Move to group…", "Rearrange"]);
      const glyph = screen.getByTestId("menu-group").querySelector("[data-testid='group-glyph']")!;
      expect((glyph.parentElement as HTMLElement).style.color).toBe("rgb(255, 0, 0)");
    });

    it("tapping Move to group… opens the picker: groups in order, the current one checked", () => {
      setup();
      const picker = openPicker(A);
      expect(screen.queryByTestId("row-menu")).toBeNull();
      const sheet = picker.querySelector("[role='dialog']") as HTMLElement;
      expect(sheet.className).toMatch(/k2-tile k2-tile-sheet/);
      expect(screen.getByTestId("group-picker-title").textContent).toBe(`Add ${A.name} to a group`);
      const items = [...picker.querySelectorAll("[role='menuitemradio']")];
      expect(items.map((i) => i.textContent)).toEqual(["Work", "Home", "No group"]);
      expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
      expect(items[0].querySelector("[data-testid='group-pick-check']")).not.toBeNull();
      expect(screen.getByTestId("group-pick-new").textContent).toBe("New Group…");
      expect(assignFocusGroup).not.toHaveBeenCalled();
      // Cancel closes without a write.
      fireEvent.click(screen.getByTestId("group-picker-cancel"));
      expect(screen.queryByTestId("group-picker")).toBeNull();
      expect(assignFocusGroup).not.toHaveBeenCalled();
    });

    it("an ungrouped agent's picker checks No group", () => {
      setup();
      openPicker(B);
      expect(screen.getByTestId("group-pick-none").getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("group-pick-g1").getAttribute("aria-checked")).toBe("false");
    });

    it("a pick assigns the workspace, moves it at once, and offers Undo", async () => {
      setup();
      vi.mocked(getCliProjectsList).mockClear();
      vi.mocked(getFocusGroupsList).mockClear();
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-g2"));
      expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pa", "g2");
      // Optimistic: membership changes before the server answers.
      expect(groupOf("pa")).toBe("g2");
      expect(screen.queryByTestId("group-picker")).toBeNull();
      // Viewing Work: alpha (now Home, not pinned) leaves the list.
      expect(screen.queryByLabelText(A.name)).toBeNull();
      expect(screen.getByTestId("group-toast-text").textContent).toBe("Moved to Home");
      await flush();
      // Assign sends no projects_changed: projects and groups are re-read.
      expect(getCliProjectsList).toHaveBeenCalled();
      expect(getFocusGroupsList).toHaveBeenCalled();
      expect(groupOf("pa")).toBe("g2");
      expect(screen.getByTestId("group-toast")).not.toBeNull();
    });

    it("Undo re-assigns the previous group", async () => {
      setup();
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-g2"));
      await flush();
      fireEvent.click(screen.getByTestId("group-toast-undo"));
      expect(assignFocusGroup).toHaveBeenLastCalledWith(expect.anything(), "pa", "g1");
      expect(groupOf("pa")).toBe("g1");
      expect(screen.queryByTestId("group-toast")).toBeNull();
      expect(screen.getByLabelText(A.name)).not.toBeNull();
      await flush();
    });

    it("No group sends null", async () => {
      setup();
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-none"));
      expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pa", null);
      expect(groupOf("pa")).toBeNull();
      // Ungrouped shows in every group: alpha stays.
      expect(screen.getByLabelText(A.name)).not.toBeNull();
      expect(screen.getByTestId("group-toast-text").textContent).toBe("Removed from Work");
      await flush();
    });

    it("picking the current group is a no-op", () => {
      setup();
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-g1"));
      expect(assignFocusGroup).not.toHaveBeenCalled();
      expect(screen.queryByTestId("group-picker")).toBeNull();
      expect(screen.queryByTestId("group-toast")).toBeNull();
    });

    it("New Group… creates the group, then assigns the agent to it", async () => {
      setup();
      vi.mocked(createFocusGroup).mockImplementation(async () => {
        const g = { id: "g3", name: "Ops", color: null, tabOrder: 2, createdAt: 0 };
        serverGroups = [...SERVER_GROUPS, g];
        return { ok: true, data: g };
      });
      openPicker(B);
      fireEvent.click(screen.getByTestId("group-pick-new"));
      const input = screen.getByTestId("group-new-name") as HTMLInputElement;
      expect((screen.getByTestId("group-new-add") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: "  Ops " } });
      fireEvent.click(screen.getByTestId("group-new-add"));
      await flush();
      expect(createFocusGroup).toHaveBeenCalledWith(expect.anything(), "Ops");
      expect(assignFocusGroup).toHaveBeenCalledWith(expect.anything(), "pb", "g3");
      expect(vi.mocked(createFocusGroup).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(assignFocusGroup).mock.invocationCallOrder[0]
      );
      expect(groupOf("pb")).toBe("g3");
      expect(useZenStore.getState().focus.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
      expect(screen.queryByTestId("group-picker")).toBeNull();
      expect(screen.getByTestId("group-toast-text").textContent).toBe("Moved to Ops");
    });

    it("a failed create keeps the sheet open with an error and assigns nothing", async () => {
      setup();
      vi.mocked(createFocusGroup).mockImplementation(async () => ({ ok: false, error: "Forbidden" }));
      openPicker(B);
      fireEvent.click(screen.getByTestId("group-pick-new"));
      fireEvent.change(screen.getByTestId("group-new-name"), { target: { value: "Ops" } });
      fireEvent.submit(screen.getByTestId("group-new-name").closest("form")!);
      await flush();
      expect(assignFocusGroup).not.toHaveBeenCalled();
      expect(screen.getByTestId("group-picker")).not.toBeNull();
      expect(screen.getByTestId("group-new-error").textContent).toBe("Could not create group");
    });

    it("a failed assign rolls back and shows the short error line", async () => {
      setup();
      vi.mocked(assignFocusGroup).mockImplementation(async () => ({ ok: false, error: "Forbidden" }));
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-g2"));
      expect(groupOf("pa")).toBe("g2");
      await flush();
      expect(groupOf("pa")).toBe("g1");
      expect(screen.getByLabelText(A.name)).not.toBeNull();
      expect(screen.getByTestId("chats-pin-error").textContent).toBe("Forbidden");
      expect(screen.queryByTestId("group-toast")).toBeNull();
    });

    it("groups off: no Move to group… item, and the hint does not mention groups", () => {
      setup([], { groups: false });
      openMenu(row(A));
      expect(screen.queryByTestId("menu-group")).toBeNull();
      expect(screen.queryByTestId("group-picker")).toBeNull();
      const hint = document.getElementById(row(A).getAttribute("aria-describedby")!)!;
      expect(hint.textContent).not.toMatch(/Swipe|group/i);
      expect(hint.textContent).toMatch(/press and hold/i);
    });

    it("search: a pinned agent's row offers Unpin and Move to group…", () => {
      setup([A.id]);
      expect(screen.getByLabelText(`Pinned ${A.name}`)).not.toBeNull();
      expect(screen.queryByLabelText(A.name)).toBeNull();
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: A.name } });
      expect(screen.queryByTestId("chats-pins")).toBeNull();
      openMenu(row(A));
      // Searching: no Rearrange.
      expect(menuLabels(screen.getByTestId("row-menu"))).toEqual(["Open", "Unpin", "Move to group…"]);
      tapItem(screen.getByTestId("menu-group"));
      expect(screen.getByTestId("group-picker-title").textContent).toBe(`Add ${A.name} to a group`);
      expect(setProjectPinned).not.toHaveBeenCalled();
      expect(useZenStore.getState().pinnedIds).toEqual([A.id]);
    });

    it("groups on: the pin menu offers Open, Unpin and Move to group…", () => {
      setup([A.id]);
      openMenu(screen.getByLabelText(`Pinned ${A.name}`));
      const menu = screen.getByTestId("pin-menu");
      expect(menuLabels(menu)).toEqual(["Open", "Unpin", "Move to group…"]);
      tapItem(screen.getByTestId("menu-unpin"));
      expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", false);
      expect(assignFocusGroup).not.toHaveBeenCalled();
    });

    it("rows and pins point at the hold hint for assistive tech", () => {
      setup([B.id]);
      const hint = document.getElementById(row(A).getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toMatch(/Press and hold an agent for options/);
      expect(hint.textContent).toMatch(/drag a pinned agent to reorder/);
      expect(screen.getByLabelText(`Pinned ${B.name}`).getAttribute("aria-describedby")).toBe(hint.id);
    });
  });
  describe("pin grid: one place per agent, long-press menu, activity", () => {
    // Newest first: bravo, alpha, charlie.
    const LAST = { "s1|t:alpha": 30, "s1|t:bravo": 50, "s1|t:charlie": 10 };
    const listIds = () =>
      [...document.querySelectorAll("[data-pin-from='list']")].map((n) =>
        n.getAttribute("data-pin-id")
      );
    const home = () => screen.getByTestId("chats-home");

    function setup(pinnedIds: string[], extra: Record<string, unknown> = {}) {
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      const pids = new Set<string>(pinnedIds.map((id) => (id === LA.id ? "pa" : id === LB.id ? "pb" : "pc")));
      useZenStore.setState({
        agentSource: "live",
        agents: LIVE_ROWS,
        serverProjects: PROJECTS.map((p) => ({ ...p, pinned: pids.has(p.id) })),
        agentError: null,
        screen: "list",
        agentId: "",
        lastAtByKey: LAST,
        pinnedIds,
        ...extra,
      });
      mount();
    }

    /** Press a pin and hold it still. */
    function hold(name: string, ms: number) {
      fireEvent.pointerDown(screen.getByLabelText(`Pinned ${name}`), {
        clientX: 40,
        clientY: 40,
        button: 0,
        pointerId: 4,
      });
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    }
    const release = () => {
      fireEvent.pointerUp(home(), { clientX: 40, clientY: 40, pointerId: 4 });
    };
    /** A fresh tap on a menu item / backdrop. */
    const tap = (el: HTMLElement) => {
      fireEvent.pointerDown(el, { clientX: 0, clientY: 0, button: 0, pointerId: 5 });
      fireEvent.pointerUp(home(), { clientX: 0, clientY: 0, pointerId: 5 });
      fireEvent.click(el);
    };

    it("pinned agents are not in the list while the grid shows", () => {
      setup([LA.id, LB.id]);
      expect(screen.getByTestId("chats-pins")).not.toBeNull();
      expect(listIds()).toEqual([LC.id]);
    });

    it("search shows pinned agents as rows and still finds everyone", () => {
      setup([LA.id, LB.id]);
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "a" } });
      // "a" is in alpha, bravo and charlie; the grid is hidden.
      expect(screen.queryByTestId("chats-pins")).toBeNull();
      // Project-list order (desktop's), pinned or not.
      expect(listIds()).toEqual([LA.id, LB.id, LC.id]);
    });

    it("pinning moves the row into the grid", () => {
      setup([LB.id]);
      expect(listIds()).toEqual([LA.id, LC.id]);
      act(() => {
        void useZenStore.getState().pinChat(LC.id);
      });
      expect(screen.getByLabelText(`Pinned ${LC.name}`)).not.toBeNull();
      expect(listIds()).toEqual([LA.id]);
    });

    it("a still hold on a pin opens Open / Unpin; Unpin moves it back to its sorted place", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      setup([LA.id, LB.id]);
      expect(listIds()).toEqual([LC.id]);
      // Under the menu delay nothing happens (no lift, no menu).
      hold(LA.name, 300);
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(250);
      });
      const menu = screen.getByTestId("pin-menu");
      expect(menu.className).toMatch(/zen-glass/);
      expect(menu.getAttribute("role")).toBe("menu");
      expect(screen.getByLabelText(`Pinned ${LA.name}`).getAttribute("aria-expanded")).toBe("true");
      // Letting go keeps the menu and does not open the chat.
      release();
      fireEvent.click(screen.getByLabelText(`Pinned ${LA.name}`));
      expect(useZenStore.getState().screen).toBe("list");
      // The hold's own release / synthetic click cannot hit an item.
      fireEvent.click(screen.getByTestId("menu-unpin"));
      expect(setProjectPinned).not.toHaveBeenCalled();
      tap(screen.getByTestId("menu-unpin"));
      expect(setProjectPinned).toHaveBeenCalledWith(expect.anything(), "pa", false);
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      expect(screen.queryByLabelText(`Pinned ${LA.name}`)).toBeNull();
      // alpha (30) sorts back between bravo's old place and charlie (10).
      expect(listIds()).toEqual([LA.id, LC.id]);
    });

    it("Open in the pin menu opens the chat; the backdrop just closes", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      setup([LA.id]);
      hold(LA.name, 600);
      release();
      tap(screen.getByTestId("pin-menu-backdrop"));
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      expect(useZenStore.getState().screen).toBe("list");
      hold(LA.name, 600);
      release();
      tap(screen.getByTestId("menu-open"));
      expect(useZenStore.getState().agentId).toBe(LA.id);
      expect(setProjectPinned).not.toHaveBeenCalled();
    });

    it("hold past the menu then move: the menu yields to the drag; off the grid it snaps back", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      setup([LA.id]);
      screen.getByTestId("chats-pins").getBoundingClientRect = () =>
        ({ left: 0, right: 300, top: 0, bottom: 90, width: 300, height: 90, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      hold(LA.name, 600);
      expect(screen.getByTestId("pin-menu")).not.toBeNull();
      fireEvent.pointerMove(home(), { clientX: 40, clientY: 400, pointerId: 4 });
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      expect(screen.getByTestId("pin-ghost")).not.toBeNull();
      fireEvent.pointerUp(home(), { clientX: 40, clientY: 400, pointerId: 4 });
      // Unpin is a menu item now: a drop below the grid changes nothing.
      expect(setProjectPinned).not.toHaveBeenCalled();
      expect(reorderProjects).not.toHaveBeenCalled();
      expect(listIds()).not.toContain(LA.id);
      expect(screen.getByLabelText(`Pinned ${LA.name}`)).not.toBeNull();
    });

    it("a working pin shows a pulsing badge and a short status; an idle one neither", () => {
      onTestFinished(() => useZenStore.setState({ activity: { byPath: {}, bySession: {} } }));
      setup([LA.id, LB.id], {
        refreshActivity: vi.fn(async () => {}),
        activity: {
          byPath: {
            "/a": { display: "working", counts: { subagents: 0, tools: 14, commands: 0 } },
            "/b": { display: "idle", counts: { subagents: 0, tools: 0, commands: 0 } },
          },
          bySession: {},
        },
      });
      const busy = screen.getByLabelText(`Pinned ${LA.name}, Working · 14 tools`);
      const dot = busy.querySelector("[data-testid='pin-activity-dot']") as HTMLElement;
      expect(dot.className).toContain("k2-pulse");
      expect(dot.style.width).toBe("20px");
      expect(dot.style.border).toMatch(/2.5px solid/);
      const line = busy.querySelector("[data-testid='pin-activity']") as HTMLElement;
      expect(line.textContent).toBe("Working · 14");
      expect(line.className).toMatch(/truncate/);
      const quiet = screen.getByLabelText(`Pinned ${LB.name}`);
      expect(quiet.querySelector("[data-testid='pin-activity-dot']")).toBeNull();
      expect(quiet.querySelector("[data-testid='pin-activity']")).toBeNull();
    });

    it("a pin that needs you is amber and does not pulse", () => {
      setup([LA.id], {
        refreshActivity: vi.fn(async () => {}),
        activity: {
          byPath: { "/a": { display: "waiting", counts: { subagents: 0, tools: 0, commands: 0 } } },
          bySession: {},
        },
      });
      onTestFinished(() => useZenStore.setState({ activity: { byPath: {}, bySession: {} } }));
      const pin = screen.getByLabelText(`Pinned ${LA.name}, Needs you`);
      const dot = pin.querySelector("[data-testid='pin-activity-dot']") as HTMLElement;
      expect(dot.className).not.toContain("k2-pulse");
      expect(dot.style.background).toBe("var(--warning)");
      expect(pin.querySelector("[data-testid='pin-activity']")?.textContent).toBe("Needs you");
    });

    it("the grid spreads near the edges with 10px of air under the header", () => {
      setup([LA.id]);
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.margin).toBe("10px 4px 0px");
      // 14px under the grid (was 8): +6px before the first list row.
      expect(grid.style.padding).toBe(`4px 2px ${ZEN_PIN_GRID_BOTTOM_PX}px`);
      expect(ZEN_PIN_GRID_BOTTOM_PX).toBe(14);
    });

    it("the first list row's top gap is unchanged with no pins", () => {
      setup([]);
      expect(screen.queryByTestId("chats-pins")).toBeNull();
      const list = screen.getByTestId("chats-list");
      expect(list.style.paddingTop).toMatch(/64px/);
      const first = list.querySelector<HTMLElement>("[data-agent-row]")!;
      expect(first.style.marginTop).toBe("");
    });

    it("one pin sits centred in a 3-column-width cell", () => {
      setup([LA.id]);
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.justifyContent).toBe("center");
      expect(zenPinGridColumns(1)).toBe(`repeat(1, calc((100% - ${2 * ZEN_PIN_COL_GAP}px) / 3))`);
      expect(grid.style.gridTemplateColumns).toBe(zenPinGridColumns(1));
    });

    it("two pins sit centred as a pair, same cell width and gap", () => {
      setup([LA.id, LB.id]);
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.justifyContent).toBe("center");
      expect(grid.style.gridTemplateColumns).toBe(zenPinGridColumns(2));
      expect(zenPinGridColumns(2)).toBe(`repeat(2, calc((100% - ${2 * ZEN_PIN_COL_GAP}px) / 3))`);
      expect(grid.style.gap).toBe(`14px ${ZEN_PIN_COL_GAP}px`);
      // The pair is two of the three 1fr cells: W - 2 gaps over 3.
      for (const w of [375, 390, 430]) {
        const content = w - 2 * (ZEN_LIST_EDGE_INSET + ZEN_LIST_EDGE_PAD);
        const cell = evalInsetPx(`calc((100% - ${2 * ZEN_PIN_COL_GAP}px) / 3)`, content);
        expect(cell).toBeCloseTo((content - 2 * ZEN_PIN_COL_GAP) / 3, 6);
      }
    });

    it("four pins: rows of three, the second row left-justified", () => {
      const LD = { id: "/d", name: "delta", initial: "D", path: "/d", addr: "delta", kind: "agent" as const };
      setup([LA.id, LB.id, LC.id, LD.id], { agents: [...LIVE_ROWS, LD] });
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
      expect(grid.style.justifyContent).toBe("");
      expect(grid.querySelectorAll("[data-pin-from='pin']").length).toBe(4);
      expect(zenPinGridColumns(3)).toBe("repeat(3, minmax(0, 1fr))");
    });

    it("the list content inset is the pinned avatars' outer edge", () => {
      // side + (cell - avatar) / 2, cell = (W - 2*side - 2*gap) / 3.
      const side = ZEN_LIST_EDGE_INSET + ZEN_LIST_EDGE_PAD;
      for (const w of [375, 390, 430]) {
        const cell = (w - 2 * side - 2 * ZEN_PIN_COL_GAP) / 3;
        const expected = side + (cell - ZEN_PIN_AVATAR_PX) / 2;
        expect(zenPinnedGroupInsetPx(w)).toBeCloseTo(expected, 6);
        expect(evalInsetPx(ZEN_LIST_CONTENT_INSET, w)).toBeCloseTo(expected, 6);
      }
      // 375pt: ~17px each side; 430pt: ~26px.
      expect(zenPinnedGroupInsetPx(375)).toBeCloseTo(17.17, 2);
      expect(zenPinnedGroupInsetPx(430)).toBeCloseTo(26.33, 2);
      // Avatars stay well clear of the screen edge.
      expect(zenPinnedGroupInsetPx(375)).toBeGreaterThanOrEqual(6);
    });

    it("pinned names still get a readable cell at 375pt", () => {
      const side = ZEN_LIST_EDGE_INSET + ZEN_LIST_EDGE_PAD;
      const cell = (375 - 2 * side - 2 * ZEN_PIN_COL_GAP) / 3;
      // Name / activity lines truncate inside the cell (110px cap at wider
      // widths); at 375pt the cell is ~96px and wider than the avatar.
      expect(cell).toBeGreaterThanOrEqual(96);
      expect(cell).toBeGreaterThan(ZEN_PIN_AVATAR_PX);
      // Cells stay clear of each other: names never touch across the gap.
      expect(ZEN_PIN_COL_GAP).toBeGreaterThanOrEqual(16);
    });

    it("the grid uses the shared pin geometry", () => {
      setup([LA.id]);
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.marginLeft).toBe(`${ZEN_LIST_EDGE_INSET}px`);
      expect(grid.style.paddingLeft).toBe(`${ZEN_LIST_EDGE_PAD}px`);
      expect(grid.style.gap).toBe(`14px ${ZEN_PIN_COL_GAP}px`);
      const circle = grid.querySelector<HTMLElement>("[data-testid='pin-avatar'] span span")!;
      expect(circle.style.width).toBe(`${ZEN_PIN_AVATAR_PX}px`);
    });

    it("list rows are full width with content confined to the pinned avatars", () => {
      setup([LA.id]);
      const inset = cssLen(ZEN_LIST_CONTENT_INSET);
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-agent-row]"));
      expect(rows.length).toBeGreaterThan(0);
      for (const wrap of rows) {
        // Tap / hold target spans the whole line.
        expect(wrap.style.marginLeft).toBe("");
        expect(wrap.style.marginRight).toBe("");
        const row = wrap.querySelector<HTMLElement>("[data-pin-from='list']")!;
        expect(row.style.paddingLeft).toBe(inset);
        // Right side runs closer to the edge; the left keeps the unread-dot room.
        expect(row.style.paddingRight).toBe("12px");
        // 12px top and bottom: the rows breathe 4px more than the old 10px.
        expect(row.style.paddingTop).toBe("12px");
        expect(row.style.paddingBottom).toBe("12px");
      }
    });

    it("the empty line uses the same inset with no pins", () => {
      useZenStore.setState({
        agents: [],
        agentSource: "live",
        agentError: null,
        screen: "list",
        pinnedIds: [],
      });
      mount();
      const empty = screen.getByTestId("chats-empty");
      expect(empty.style.paddingLeft).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
      expect(empty.style.paddingRight).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
    });

    it("search hits keep the inset", () => {
      setup([LA.id]);
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: LA.name } });
      expect(screen.queryByTestId("chats-pins")).toBeNull();
      const row = document.querySelector<HTMLElement>(`[data-pin-from='list'][data-pin-id='${LA.id}']`)!;
      expect(row).not.toBeNull();
      expect(row.style.paddingLeft).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
      expect(row.style.paddingRight).toBe("12px");
      expect(row.style.paddingTop).toBe("12px");
      expect(row.style.paddingBottom).toBe("12px");
    });
  });

  describe("Rearrange (Agents)", () => {
    const LD = { id: "/d", name: "delta", initial: "D", path: "/d", addr: "delta", kind: "agent" as const };
    const ORDERED: ServerProject[] = [
      project("pa", "alpha", { tabOrder: 0 }),
      project("pb", "bravo", { tabOrder: 1, pinned: true }),
      project("pc", "charlie", { tabOrder: 2 }),
      { ...project("pd", "delta", { tabOrder: 3 }), path: "/d" },
    ];
    const listIds = () =>
      [...document.querySelectorAll("[data-pin-from='list']")].map((n) => n.getAttribute("data-pin-id"));
    const grips = () => screen.queryAllByTestId("rearrange-grip");

    beforeEach(() => {
      vi.useFakeTimers();
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      useRecentFirstStore.getState().setOn(false);
      useZenStore.setState({
        agentSource: "live",
        agents: [...LIVE_ROWS, LD],
        serverProjects: ORDERED,
        agentError: null,
        screen: "list",
        agentId: "",
        pinnedIds: ["/b"],
        lastAtByKey: {},
      });
      mount();
    });
    afterEach(() => {
      vi.useRealTimers();
      useRecentFirstStore.getState().setOn(false);
    });

    function enter() {
      holdOpen(screen.getByLabelText("alpha"));
      tapItem(screen.getByTestId("menu-rearrange"));
    }

    it("grips left of the avatars and a blue Done above the search bar; taps and holds are off until Done", () => {
      expect(grips()).toHaveLength(0);
      expect(screen.queryByTestId("rearrange-done")).toBeNull();
      enter();
      expect(screen.queryByTestId("row-menu")).toBeNull();
      // The list's rows (the pinned bravo stays in the grid).
      expect(listIds()).toEqual(["/a", "/c", "/d"]);
      expect(grips()).toHaveLength(3);
      expect(grips().map((g) => g.getAttribute("aria-label"))).toEqual([
        "Reorder alpha",
        "Reorder charlie",
        "Reorder delta",
      ]);
      // The grip sits before the row (left of the avatar), which makes room.
      const alpha = screen.getByLabelText("alpha");
      expect(grips()[0].nextElementSibling).toBe(alpha);
      expect(grips()[0].style.touchAction).toBe("none");
      expect(alpha.style.paddingLeft).toBe(cssLen(`calc(${ZEN_LIST_CONTENT_INSET} + 40px)`));
      const done = screen.getByTestId("rearrange-done");
      expect(done.textContent).toBe("Done");
      expect(done.className).toContain("k2-tile");
      expect(done.style.background).toBe("rgb(10, 132, 255)");
      expect(done.style.right).toBe("16px");
      expect(done.style.bottom).toContain(SEARCH_BAR_REST_BOTTOM);
      // A tap does not open the chat; a hold opens no menu.
      fireEvent.click(alpha);
      expect(useZenStore.getState().screen).toBe("list");
      holdOpen(alpha);
      expect(screen.queryByTestId("row-menu")).toBeNull();
      // Pins rest too.
      holdOpen(screen.getByLabelText("Pinned bravo"));
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      fireEvent.click(screen.getByLabelText("Pinned bravo"));
      expect(useZenStore.getState().screen).toBe("list");
      fireEvent.click(done);
      expect(grips()).toHaveLength(0);
      expect(screen.queryByTestId("rearrange-done")).toBeNull();
      expect(alpha.style.paddingLeft).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
      fireEvent.click(alpha);
      expect(useZenStore.getState().agentId).toBe("/a");
    });

    it("a grip drag reorders at once and writes the full server order; pins keep their slots", () => {
      enter();
      dragGrip(screen.getByTestId("chats-list"), 2, 0);
      // delta to the top: a, c, d hold slots 0, 2, 3 of the server order.
      expect(reorderProjects).toHaveBeenCalledTimes(1);
      expect(reorderProjects).toHaveBeenCalledWith(expect.anything(), ["pd", "pb", "pa", "pc"]);
      expect(setProjectPinned).not.toHaveBeenCalled();
      expect(listIds()).toEqual(["/d", "/a", "/c"]);
      expect(useZenStore.getState().pinnedIds).toEqual(["/b"]);
      // Still rearranging until Done.
      expect(grips()).toHaveLength(3);
      dragGrip(screen.getByTestId("chats-list"), 0, 2);
      expect(reorderProjects).toHaveBeenLastCalledWith(expect.anything(), ["pa", "pb", "pc", "pd"]);
      expect(listIds()).toEqual(["/a", "/c", "/d"]);
    });

    it("pins drag at once (no hold) in Rearrange, inside the lit grid outline", () => {
      useZenStore.setState({
        serverProjects: ORDERED.map((p) => (p.id === "pa" ? { ...p, pinned: true } : p)),
        pinnedIds: ["/a", "/b"],
      });
      holdOpen(screen.getByLabelText("charlie"));
      tapItem(screen.getByTestId("menu-rearrange"));
      const grid = screen.getByTestId("chats-pins");
      expect(grid.style.outline).toContain("dashed rgba(10,132,255");
      grid.getBoundingClientRect = () =>
        ({ left: 0, right: 300, top: 0, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      const cell = (name: string, left: number) => {
        screen.getByLabelText(`Pinned ${name}`).getBoundingClientRect = () =>
          ({ left, right: left + 80, top: 0, bottom: 80, width: 80, height: 80, x: left, y: 0, toJSON() { return {}; } }) as DOMRect;
      };
      cell("alpha", 0);
      cell("bravo", 100);
      const home = screen.getByTestId("chats-home");
      fireEvent.pointerDown(screen.getByLabelText("Pinned bravo"), { clientX: 140, clientY: 40, pointerId: 9 });
      fireEvent.pointerMove(home, { clientX: 120, clientY: 40, pointerId: 9 });
      // Lifted straight away: no menu, a ghost, and alpha slides right.
      expect(screen.queryByTestId("pin-menu")).toBeNull();
      expect(screen.getByTestId("pin-ghost")).not.toBeNull();
      fireEvent.pointerMove(home, { clientX: 30, clientY: 40, pointerId: 9 });
      expect(screen.getByLabelText("Pinned alpha").style.transform).toBe("translate(100px, 0px)");
      fireEvent.pointerUp(home, { clientX: 30, clientY: 40, pointerId: 9 });
      expect(reorderProjects).toHaveBeenLastCalledWith(expect.anything(), ["pb", "pa"]);
      expect(useZenStore.getState().pinnedIds).toEqual(["/b", "/a"]);
      // Still rearranging, and the grid stays lit.
      expect(screen.getByTestId("rearrange-done")).not.toBeNull();
      expect(screen.getByTestId("chats-pins").style.outline).toContain("dashed rgba(10,132,255");
    });

    it("a drop back on its own slot writes nothing", () => {
      enter();
      dragGrip(screen.getByTestId("chats-list"), 1, 1);
      expect(reorderProjects).not.toHaveBeenCalled();
      expect(listIds()).toEqual(["/a", "/c", "/d"]);
    });

    it("while dragging, the rows in between slide to make room", () => {
      enter();
      const list = screen.getByTestId("chats-list");
      const keyed = () => [...list.querySelectorAll<HTMLElement>("[data-rearrange-key]")];
      // Lay out, press delta's grip, move it over alpha's slot, hold there.
      // (dragGrip releases; this checks the mid-drag frame.)
      keyed().forEach((n, i) => {
        n.getBoundingClientRect = () =>
          ({ left: 0, right: 375, top: i * 70, bottom: i * 70 + 70, width: 375, height: 70, x: 0, y: i * 70, toJSON() { return {}; } }) as DOMRect;
      });
      list.getBoundingClientRect = () =>
        ({ left: 0, right: 375, top: 0, bottom: 2000, width: 375, height: 2000, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      const grip = grips()[2];
      fireEvent.pointerDown(grip, { clientX: 10, clientY: 175, button: 0, pointerId: 9 });
      fireEvent.pointerMove(grip, { clientX: 10, clientY: 30, pointerId: 9 });
      const [a, c, d] = keyed();
      expect(d.dataset.dragging).toBe("1");
      expect(d.style.transform).toBe("translateY(-145px)");
      expect(a.style.transform).toBe("translateY(70px)");
      expect(c.style.transform).toBe("translateY(70px)");
      expect(a.style.transition).toMatch(/transform 200ms/);
      fireEvent.pointerCancel(grip, { pointerId: 9 });
      expect(a.style.transform).toBe("");
      expect(reorderProjects).not.toHaveBeenCalled();
    });

    it("only with Recent agents first off and no search; turning it on or typing a search ends it", () => {
      act(() => useRecentFirstStore.getState().setOn(true));
      holdOpen(screen.getByLabelText("alpha"));
      expect(screen.queryByTestId("menu-rearrange")).toBeNull();
      tapItem(screen.getByTestId("row-menu-backdrop"));
      act(() => useRecentFirstStore.getState().setOn(false));
      enter();
      expect(grips()).toHaveLength(3);
      act(() => useRecentFirstStore.getState().setOn(true));
      expect(grips()).toHaveLength(0);
      expect(screen.queryByTestId("rearrange-done")).toBeNull();
      act(() => useRecentFirstStore.getState().setOn(false));
      enter();
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "a" } });
      expect(grips()).toHaveLength(0);
      expect(screen.queryByTestId("rearrange-done")).toBeNull();
      holdOpen(screen.getByLabelText("alpha"));
      expect(screen.queryByTestId("menu-rearrange")).toBeNull();
    });

    it("a pinned avatar's menu has no Rearrange (pins reorder by hold and drag)", () => {
      holdOpen(screen.getByLabelText("Pinned bravo"));
      expect(menuLabels(screen.getByTestId("pin-menu"))).toEqual(["Open", "Unpin"]);
    });
  });

  describe("server pins and focus groups", () => {
    const SIDE = {
      id: "/a::alpha/1",
      name: "alpha",
      initial: "A",
      path: "/a",
      addr: "alpha/1",
      chatTitle: "reviewer",
      hostLive: true,
      kind: "agent" as const,
    };
    const GROUPS = [
      { id: "g1", name: "Work", color: "#ff0000" },
      { id: "g2", name: "A very long focus group name that must truncate", color: null },
    ];
    // alpha: g1. bravo: g2 (pinned). charlie: ungrouped.
    const GROUPED: ServerProject[] = [
      project("pa", "alpha", { focusGroupId: "g1" }),
      project("pb", "bravo", { focusGroupId: "g2", pinned: true }),
      project("pc", "charlie"),
      { ...project("px", "delta", { focusGroupId: "g2" }), path: "/d" },
    ];
    const LD = { id: "/d", name: "delta", initial: "D", path: "/d", addr: "delta", kind: "agent" as const };

    function live(extra: Record<string, unknown> = {}) {
      useZenStore.setState({
        agentSource: "live",
        agents: [...LIVE_ROWS, LD, SIDE],
        serverProjects: GROUPED,
        pinnedIds: ["/b"],
        agentError: null,
        screen: "list",
        lastAtByKey: {},
        ...extra,
      });
    }
    const rowNames = () =>
      [...document.querySelectorAll("[data-pin-from='list']")].map((n) =>
        n.getAttribute("data-pin-id")
      );
    const pinNames = () =>
      [...document.querySelectorAll("[data-pin-from='pin']")].map((n) =>
        n.getAttribute("data-pin-id")
      );

    it("a sidecar row's menu is Open (and Mute): no Pin, Move to group… or grip", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      const side = document.querySelector(`[data-pin-id="${SIDE.id}"][data-pin-from='list']`) as HTMLElement;
      holdOpen(side);
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
      expect(menuLabels(screen.getByTestId("row-menu"))).toEqual(["Open"]);
      tapItem(screen.getByTestId("row-menu-backdrop"));
      expect(screen.queryByTestId("row-menu")).toBeNull();
      // A workspace row in the same list has the full set.
      holdOpen(screen.getByLabelText(LA.name));
      expect(menuLabels(screen.getByTestId("row-menu"))).toEqual(["Open", "Pin", "Move to group…", "Rearrange"]);
      expect(setProjectPinned).not.toHaveBeenCalled();
    });

    it("groups off: the title is Agents, not a button, and every agent shows once", () => {
      live();
      mount();
      const title = screen.getByTestId("chats-title");
      expect(title.textContent).toBe("Agents");
      expect(title.querySelector("button")).toBeNull();
      expect(rowNames()).toEqual(expect.arrayContaining(["/a", "/c", "/d", SIDE.id]));
      // bravo is pinned: in the grid, not repeated in the list.
      expect(rowNames()).not.toContain("/b");
      expect(pinNames()).toEqual(["/b"]);
    });

    it("groups on: the title is the current group's name with its colour dot, capped to fit", () => {
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      const title = screen.getByTestId("chats-title");
      expect(title.textContent).toBe("Work");
      // 375pt: 375 - 24 padding - 16 gaps - 2 × 118 (Projects, Tickets, cog) = 99px.
      expect(title.style.maxWidth).toBe("min(calc(100vw - 276px), 140px)");
      expect(screen.getByTestId("chats-title-dot").style.background).toMatch(/rgb\(255, 0, 0\)|#ff0000/);
      expect(title.querySelector(".truncate")?.textContent).toBe("Work");
    });

    it("filter: pinned + current group + ungrouped; sidecars follow their workspace", () => {
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      const names = rowNames();
      // alpha (g1) + its sidecar, charlie (ungrouped) in the list; bravo
      // (pinned, g2) in the grid only.
      expect(names).toEqual(expect.arrayContaining(["/a", SIDE.id, "/c"]));
      expect(names).not.toContain("/b");
      expect(pinNames()).toEqual(["/b"]);
      // delta is in g2 and not pinned.
      expect(names).not.toContain("/d");
    });

    it("search ignores the focus group so any agent can be found", () => {
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "delta" } });
      expect(rowNames()).toEqual(["/d"]);
    });

    it("tapping the title opens a switcher; a pick changes only this view", () => {
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      // Takes the tap through the inert floating header.
      expect(screen.getByTestId("chats-title-group").style.pointerEvents).toBe("auto");
      fireEvent.click(screen.getByTestId("chats-title-group"));
      const menu = screen.getByTestId("focus-menu");
      const items = menu.querySelectorAll("[role='menuitemradio']");
      expect(items).toHaveLength(2);
      expect(items[0].getAttribute("aria-checked")).toBe("true");
      expect(items[0].querySelector("[data-testid='focus-check']")).not.toBeNull();
      fireEvent.click(screen.getByTestId("focus-option-g2"));
      expect(screen.queryByTestId("focus-menu")).toBeNull();
      expect(screen.getByTestId("chats-title").textContent).toBe(GROUPS[1].name);
      expect(rowNames()).toContain("/d");
      expect(rowNames()).not.toContain("/a");
      expect(localStorage.getItem("zen.focusGroup.s1")).toBe("g2");
      expect(setProjectPinned).not.toHaveBeenCalled();
    });

    it("a failed pin write shows a short error line", () => {
      live({ pinError: "Could not pin" });
      mount();
      expect(screen.getByTestId("chats-pin-error").textContent).toBe("Could not pin");
    });

    it("re-reads server pins and groups on mount and on app foreground", () => {
      const refreshServerLists = vi.fn();
      const orig = useZenStore.getState().refreshServerLists;
      onTestFinished(() => useZenStore.setState({ refreshServerLists: orig }));
      live({ refreshServerLists });
      mount();
      expect(refreshServerLists).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(refreshServerLists).toHaveBeenCalledTimes(2);
    });
  });
});

describe("ChatsList search bar — mobile chat kit FLIP", () => {
  afterEach(() => {
    __resetViewportForTests();
  });
  it("keyboard show: the search bar and its blur play up by transform; the column holds (no height transition)", () => {
    seedServer();
    mount();
    const bar = screen.getByRole("searchbox").closest<HTMLElement>("[data-no-pin]")!;
    const blur = screen.getByTestId("search-bar-blur");
    const column = screen.getByTestId("chats-column");
    act(() => {
      (window as unknown as { __k2KeyboardWill: (d: unknown) => void }).__k2KeyboardWill({
        height: 336,
        duration: 250,
        curve: 7,
        show: true,
      });
    });
    expect(bar.style.transform).toBe("translate3d(0, -336px, 0)");
    expect(blur.style.transform).toBe("translate3d(0, -336px, 0)");
    expect(bar.style.transition).toMatch(/^transform 250ms /);
    expect(column.style.height).toBe(`${window.innerHeight}px`);
    expect(column.style.transition).toBe("");
  });
});
