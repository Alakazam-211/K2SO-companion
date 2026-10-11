// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  zenPinnedGroupInsetPx,
} from "./ChatsList";

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
import { FOCUS_OFF, type ServerProject } from "./serverPins";

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
    expect((screen.getByRole("button", { name: "New message" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Tickets" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Server / })).not.toBeNull();
    expect(screen.queryByTestId("tickets-badge")).toBeNull();
  });

  it("header: server button on the left, Tickets then the settings cog on the right, all 34px", () => {
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
    expect(cog.querySelector("[data-testid=settings-icon]")).not.toBeNull();
    const rightButtons = Array.from(right.children);
    expect(rightButtons).toEqual([screen.getByRole("button", { name: "Tickets" }), cog]);

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

  it("Settings → Leave Zen Mode is the toggle to the original UI; Done closes", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Leave Zen Mode" })).not.toBeNull();
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
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.getByLabelText("Skin Test A")).not.toBeNull();
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

  it("hold-drag a chat onto the pin grid pins it, drag a pin down unpins", () => {
    vi.useFakeTimers();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
    useZenStore.setState({
      agentSource: "live",
      agents: LIVE_ROWS,
      serverProjects: PROJECTS,
      agentError: null,
      screen: "list",
      pinnedIds: [],
    });
    mount();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    expect(screen.queryByTestId("chats-pin-drop")).toBeNull();
    const row = screen.getByLabelText("alpha");
    fireEvent.pointerDown(row, { clientX: 20, clientY: 200, button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // No pins yet: the hold-drag gets a temporary glass drop strip.
    const drop = screen.getByTestId("chats-pin-drop");
    expect(drop.className).toMatch(/k2-pin-drop/);
    expect(drop.textContent).toMatch(/Drop to pin/);
    // Same width as the pinned avatars it stands in for.
    expect(drop.style.left).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
    expect(drop.style.right).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
    drop.getBoundingClientRect = () =>
      ({
        left: 0,
        right: 300,
        top: 0,
        bottom: 90,
        width: 300,
        height: 90,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    expect(screen.getByTestId("chats-list").style.overflowY).toBe("hidden");
    expect(screen.getByTestId("chats-list").style.touchAction).toBe("none");
    fireEvent.pointerUp(screen.getByTestId("chats-home"), {
      clientX: 40,
      clientY: 40,
      pointerId: 1,
    });
    // Server pin: projects/update {id, pinned: 1}, then the drop spot.
    expect(setProjectPinned).toHaveBeenCalledWith("pa", true);
    expect(useZenStore.getState().pinnedIds).toEqual(["/a"]);
    expect(screen.getByLabelText("Pinned alpha")).not.toBeNull();
    // Pinned: it moved into the grid, so its list row is gone.
    expect(screen.queryByLabelText("alpha")).toBeNull();
    // The strip goes with the drag; the real grid takes over.
    expect(screen.queryByTestId("chats-pin-drop")).toBeNull();
    expect(screen.getByTestId("chats-pins")).not.toBeNull();
    screen.getByTestId("chats-pins").getBoundingClientRect = () =>
      ({
        left: 0,
        right: 300,
        top: 0,
        bottom: 90,
        width: 300,
        height: 90,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    fireEvent.pointerDown(screen.getByLabelText("Pinned alpha"), {
      clientX: 40,
      clientY: 40,
      button: 0,
      pointerId: 2,
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // A pin lifts on movement (a still hold is its menu).
    expect(screen.queryByTestId("pin-ghost")).toBeNull();
    fireEvent.pointerMove(screen.getByTestId("chats-home"), {
      clientX: 40,
      clientY: 400,
      pointerId: 2,
    });
    expect(screen.getByTestId("pin-ghost")).not.toBeNull();
    fireEvent.pointerUp(screen.getByTestId("chats-home"), {
      clientX: 40,
      clientY: 400,
      pointerId: 2,
    });
    expect(setProjectPinned).toHaveBeenLastCalledWith("pa", false);
    expect(useZenStore.getState().pinnedIds).toEqual([]);
    expect(screen.queryByLabelText("Pinned alpha")).toBeNull();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    // Back in the list.
    expect(screen.getByLabelText("alpha")).not.toBeNull();
    vi.useRealTimers();
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
    expect(reorderProjects).toHaveBeenCalledWith(["pb", "pa"]);
    expect(setProjectPinned).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("orders chats by last-message time, newest first", () => {
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
      lastAtByKey: { "t:old": 10, "t:new": 50 },
      agentError: null,
      screen: "list",
    });
    mount();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const chats = names.filter((n) => n === "older chat" || n === "newer chat");
    expect(chats).toEqual(["newer chat", "older chat"]);
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
      lastAtByKey: { "t:appa": Date.now() / 1000 },
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("main chat");
    expect(screen.getByTestId("row-when").textContent).toMatch(/›/);
    expect(screen.getByTestId("row-when").textContent).toMatch(/\d{1,2}:\d{2}/);
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
    expect(screen.getByTestId("row-when").textContent?.replace(/\s/g, "")).toBe("›");
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

  it("the plus button opens the New Message picker", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(screen.getByTestId("overlay-compose")).not.toBeNull();
    expect(screen.getByText("New Message")).not.toBeNull();
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

  it("a project chat row says Project Chat", () => {
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
    mount();
    expect(screen.getByLabelText("K2 Companion")).not.toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("Project Chat");
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

  describe("swipe right to group", () => {
    const A = LA;
    const B = LB;
    const ROW_W = 375;
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
      sizeRows();
    }
    function sizeRows() {
      for (const a of LIVE_ROWS) {
        const wrap = document.querySelector(`[data-swipe-row="${a.id}"]`) as HTMLElement | null;
        if (!wrap) continue; // pinned: in the grid, not the list
        wrap.getBoundingClientRect = () =>
          ({ left: 0, right: ROW_W, top: 0, bottom: 70, width: ROW_W, height: 70, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      }
    }
    type Row = (typeof LIVE_ROWS)[number];
    const row = (a: Row) => screen.getByLabelText(a.name);
    const action = (a: Row) => screen.getByTestId(`swipe-action-${a.id}`);
    const home = () => screen.getByTestId("chats-home");
    const groupOf = (pid: string) =>
      useZenStore.getState().serverProjects.find((p) => p.id === pid)?.focusGroupId ?? null;
    const flush = () => act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    /** Pointer down on the row, move through the points, release. */
    function drag(a: Row, points: [number, number][], up = true) {
      fireEvent.pointerDown(row(a), { clientX: 20, clientY: 200, button: 0, pointerId: 7 });
      for (const [x, y] of points) {
        fireEvent.pointerMove(home(), { clientX: x, clientY: y, pointerId: 7 });
      }
      if (up) {
        const [x, y] = points[points.length - 1] ?? [20, 200];
        fireEvent.pointerUp(home(), { clientX: x, clientY: y, pointerId: 7 });
      }
    }
    /** Swipe the row open and tap its Group button. */
    function openPicker(a: Row) {
      drag(a, [[34, 200], [110, 200]]);
      fireEvent.pointerDown(action(a), { clientX: 30, clientY: 200, button: 0, pointerId: 8 });
      fireEvent.pointerUp(home(), { clientX: 30, clientY: 200, pointerId: 8 });
      fireEvent.click(action(a));
      return screen.getByTestId("group-picker");
    }

    it("a swipe right reveals a round glass Group button, not Pin", () => {
      setup();
      drag(B, [[34, 201], [70, 202], [110, 203]]);
      const btn = action(B);
      expect(btn.style.width).toBe("76px");
      // The revealed strip is clear, not a slab.
      expect(btn.style.background).toBe("transparent");
      const glass = btn.querySelector("[data-testid='swipe-action-glass']") as HTMLElement;
      expect(glass.className).toMatch(/k2-swipe-pin/);
      expect(glass.className).toMatch(/k2-swipe-group/);
      // Ungrouped: white glyph, "Group" label.
      expect(glass.style.color).toBe("rgb(255, 255, 255)");
      expect(glass.style.transform).toBe("scale(1)");
      expect(
        (btn.querySelector("[data-testid='swipe-action-reveal']") as HTMLElement).style.opacity
      ).toBe("1");
      expect(btn.getAttribute("aria-label")).toBe(`Group ${B.name}`);
      expect(btn.textContent).toBe("Group");
      expect(glass.querySelector("[data-testid='group-glyph']")).not.toBeNull();
      expect(btn.querySelector("[data-testid='pin-glyph'], [data-testid='unpin-glyph']")).toBeNull();
      expect(row(B).style.transform).toBe("translateX(76px)");
      // The swipe's click does not open the chat.
      fireEvent.click(row(B));
      expect(useZenStore.getState().screen).toBe("list");
    });

    it("a grouped agent's action shows its group's colour and name", () => {
      setup();
      const btn = action(A);
      const glass = btn.querySelector("[data-testid='swipe-action-glass']") as HTMLElement;
      expect(glass.style.color).toBe("rgb(255, 0, 0)");
      expect(screen.getAllByTestId("swipe-action-label")[0].className).toMatch(/truncate/);
      expect(btn.textContent).toBe("Work");
      expect(btn.getAttribute("aria-label")).toBe(`Group ${A.name}, in Work`);
    });

    it("the glass button scales and fades in with the drag", () => {
      setup();
      const glass = () =>
        action(A).querySelector("[data-testid='swipe-action-glass']") as HTMLElement;
      const reveal = () =>
        action(A).querySelector("[data-testid='swipe-action-reveal']") as HTMLElement;
      expect(reveal().style.opacity).toBe("0");
      expect(glass().style.transform).toBe("scale(0.6)");
      // 30px of a 60px open threshold: halfway in.
      drag(A, [[50, 200]], false);
      expect(action(A).style.width).toBe("30px");
      expect(reveal().style.opacity).toBe("0.5");
      expect(glass().style.transform).toBe("scale(0.8)");
      expect(glass().style.transition).toBe("none");
      fireEvent.pointerMove(home(), { clientX: 80, clientY: 200, pointerId: 7 });
      expect(reveal().style.opacity).toBe("1");
      expect(glass().style.transform).toBe("scale(1)");
      expect(glass().dataset.armed).toBeUndefined();
      fireEvent.pointerUp(home(), { clientX: 80, clientY: 200, pointerId: 7 });
    });

    it("tapping Group opens the picker: groups in order, the current one checked", () => {
      setup();
      const picker = openPicker(A);
      expect(row(A).style.transform).toBe("translateX(0px)");
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
      expect(assignFocusGroup).toHaveBeenCalledWith("pa", "g2");
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
      expect(assignFocusGroup).toHaveBeenLastCalledWith("pa", "g1");
      expect(groupOf("pa")).toBe("g1");
      expect(screen.queryByTestId("group-toast")).toBeNull();
      expect(screen.getByLabelText(A.name)).not.toBeNull();
      await flush();
    });

    it("No group sends null", async () => {
      setup();
      openPicker(A);
      fireEvent.click(screen.getByTestId("group-pick-none"));
      expect(assignFocusGroup).toHaveBeenCalledWith("pa", null);
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
      expect(createFocusGroup).toHaveBeenCalledWith("Ops");
      expect(assignFocusGroup).toHaveBeenCalledWith("pb", "g3");
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

    it("a full swipe opens the picker and assigns nothing", () => {
      setup();
      drag(A, [[34, 200], [150, 200], [240, 200]], false);
      expect(action(A).style.width).toBe("220px");
      expect(
        (action(A).querySelector("[data-testid='swipe-action-glyph']") as HTMLElement).style.transform
      ).toBe("scale(1.2)");
      expect(
        (action(A).querySelector("[data-testid='swipe-action-glass']") as HTMLElement).dataset.armed
      ).toBe("1");
      fireEvent.pointerUp(home(), { clientX: 240, clientY: 200, pointerId: 7 });
      expect(screen.getByTestId("group-picker")).not.toBeNull();
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(assignFocusGroup).not.toHaveBeenCalled();
      expect(setProjectPinned).not.toHaveBeenCalled();
      expect(useZenStore.getState().pinnedIds).toEqual([]);
    });

    it("groups off: no swipe action on any row, and the hint does not mention it", () => {
      setup([], { groups: false });
      for (const a of LIVE_ROWS) expect(screen.queryByTestId(`swipe-action-${a.id}`)).toBeNull();
      drag(A, [[34, 200], [110, 200]]);
      expect(row(A).style.transform).toBe("translateX(0px)");
      drag(A, [[34, 200], [150, 200], [240, 200]]);
      expect(screen.queryByTestId("group-picker")).toBeNull();
      expect(setProjectPinned).not.toHaveBeenCalled();
      const hint = document.getElementById(row(A).getAttribute("aria-describedby")!)!;
      expect(hint.textContent).not.toMatch(/Swipe/);
      expect(hint.textContent).toMatch(/press and hold/i);
    });

    it("a short swipe springs back", () => {
      setup();
      drag(A, [[34, 200], [60, 200]]);
      expect(action(A).style.width).toBe("0px");
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(screen.queryByTestId("group-picker")).toBeNull();
    });

    it("a vertical drag does not open the row", () => {
      setup();
      drag(A, [[24, 215], [28, 260], [30, 320]]);
      expect(action(A).style.width).toBe("0px");
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
    });

    it("only one row is open at a time", () => {
      setup();
      drag(A, [[34, 200], [110, 200]]);
      expect(row(A).style.transform).toBe("translateX(76px)");
      drag(B, [[34, 200], [110, 200]]);
      expect(row(B).style.transform).toBe("translateX(76px)");
      expect(row(A).style.transform).toBe("translateX(0px)");
    });

    it("a tap elsewhere closes the open row without opening a chat", () => {
      setup();
      drag(A, [[34, 200], [110, 200]]);
      fireEvent.pointerDown(row(B), { clientX: 20, clientY: 260, button: 0, pointerId: 9 });
      fireEvent.pointerUp(home(), { clientX: 20, clientY: 260, pointerId: 9 });
      fireEvent.click(row(B));
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(useZenStore.getState().screen).toBe("list");
    });

    it("scrolling the list closes the open row", () => {
      setup();
      drag(A, [[34, 200], [110, 200]]);
      fireEvent.scroll(screen.getByTestId("chats-list"));
      expect(row(A).style.transform).toBe("translateX(0px)");
    });

    it("search: a pinned agent's row gets Group like everyone else, not Unpin", () => {
      setup([A.id]);
      expect(screen.getByLabelText(`Pinned ${A.name}`)).not.toBeNull();
      expect(screen.queryByLabelText(A.name)).toBeNull();
      fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: A.name } });
      expect(screen.queryByTestId("chats-pins")).toBeNull();
      sizeRows();
      openPicker(A);
      expect(screen.getByTestId("group-picker-title").textContent).toBe(`Add ${A.name} to a group`);
      expect(setProjectPinned).not.toHaveBeenCalled();
      expect(useZenStore.getState().pinnedIds).toEqual([A.id]);
    });

    it("a committed swipe cancels the hold timer; hold-drag still pins", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      setup();
      drag(A, [[34, 200]], false);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
      fireEvent.pointerUp(home(), { clientX: 34, clientY: 200, pointerId: 7 });

      // Hold first: the swipe no longer starts and the ghost drags as before.
      fireEvent.pointerDown(row(B), { clientX: 20, clientY: 260, button: 0, pointerId: 10 });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.pointerMove(home(), { clientX: 120, clientY: 262, pointerId: 10 });
      expect(screen.getByTestId("pin-ghost")).not.toBeNull();
      expect(row(B).style.transform).toBe("translateX(0px)");
      const drop = screen.getByTestId("chats-pin-drop");
      drop.getBoundingClientRect = () =>
        ({ left: 0, right: 300, top: 0, bottom: 90, width: 300, height: 90, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      fireEvent.pointerUp(home(), { clientX: 40, clientY: 40, pointerId: 10 });
      expect(setProjectPinned).toHaveBeenCalledWith("pb", true);
      expect(screen.getByLabelText(`Pinned ${B.name}`)).not.toBeNull();
      expect(assignFocusGroup).not.toHaveBeenCalled();
      expect(screen.queryByTestId("group-picker")).toBeNull();
    });

    it("groups on: the pin menu still offers Open and Unpin", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      setup([A.id]);
      fireEvent.pointerDown(screen.getByLabelText(`Pinned ${A.name}`), {
        clientX: 40,
        clientY: 40,
        button: 0,
        pointerId: 4,
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.pointerUp(home(), { clientX: 40, clientY: 40, pointerId: 4 });
      expect(screen.getByTestId("pin-menu-open")).not.toBeNull();
      const unpin = screen.getByTestId("pin-menu-unpin");
      fireEvent.pointerDown(unpin, { clientX: 0, clientY: 0, button: 0, pointerId: 5 });
      fireEvent.pointerUp(home(), { clientX: 0, clientY: 0, pointerId: 5 });
      fireEvent.click(unpin);
      expect(setProjectPinned).toHaveBeenCalledWith("pa", false);
      expect(assignFocusGroup).not.toHaveBeenCalled();
    });

    it("rows point at the swipe hint for assistive tech", () => {
      setup();
      const hint = document.getElementById(row(A).getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toMatch(/Swipe right to add to a focus group/);
      expect(hint.textContent).toMatch(/drag to the top to pin/);
    });
  });
  describe("pin grid: one place per agent, long-press menu, activity", () => {
    // Newest first: bravo, alpha, charlie.
    const LAST = { "t:alpha": 30, "t:bravo": 50, "t:charlie": 10 };
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
      expect(listIds()).toEqual([LB.id, LA.id, LC.id]);
      // Groups off: the swipe offers nothing (it no longer pins).
      expect(screen.queryByTestId(`swipe-action-${LA.id}`)).toBeNull();
      expect(screen.queryByTestId(`swipe-action-${LC.id}`)).toBeNull();
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
      fireEvent.click(screen.getByTestId("pin-menu-unpin"));
      expect(setProjectPinned).not.toHaveBeenCalled();
      tap(screen.getByTestId("pin-menu-unpin"));
      expect(setProjectPinned).toHaveBeenCalledWith("pa", false);
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
      tap(screen.getByTestId("pin-menu-open"));
      expect(useZenStore.getState().agentId).toBe(LA.id);
      expect(setProjectPinned).not.toHaveBeenCalled();
    });

    it("hold past the menu then move: the menu yields to the drag", () => {
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
      expect(setProjectPinned).toHaveBeenCalledWith("pa", false);
      expect(listIds()).toContain(LA.id);
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
      expect(grid.style.padding).toBe("4px 2px 8px");
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
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-swipe-row]"));
      expect(rows.length).toBeGreaterThan(0);
      for (const wrap of rows) {
        // Tap / swipe target spans the whole line.
        expect(wrap.style.marginLeft).toBe("");
        expect(wrap.style.marginRight).toBe("");
        const row = wrap.querySelector<HTMLElement>("[data-pin-from='list']")!;
        expect(row.style.paddingLeft).toBe(inset);
        expect(row.style.paddingRight).toBe(inset);
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
      expect(row.style.paddingRight).toBe(cssLen(ZEN_LIST_CONTENT_INSET));
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

    it("a sidecar row has no Group action and does not swipe", () => {
      live({ focus: { enabled: true, currentId: "g1", groups: GROUPS } });
      mount();
      expect(screen.queryByTestId(`swipe-action-${SIDE.id}`)).toBeNull();
      expect(screen.getByTestId(`swipe-action-${LA.id}`)).not.toBeNull();
      const side = document.querySelector(`[data-swipe-row="${SIDE.id}"] [data-pin-from='list']`) as HTMLElement;
      const home = screen.getByTestId("chats-home");
      fireEvent.pointerDown(side, { clientX: 20, clientY: 300, button: 0, pointerId: 3 });
      fireEvent.pointerMove(home, { clientX: 60, clientY: 300, pointerId: 3 });
      fireEvent.pointerMove(home, { clientX: 140, clientY: 300, pointerId: 3 });
      fireEvent.pointerUp(home, { clientX: 140, clientY: 300, pointerId: 3 });
      expect(side.style.transform).toBe("translateX(0px)");
      expect(screen.queryByTestId("group-picker")).toBeNull();
    });

    it("a sidecar row cannot be hold-dragged into the pins", () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      live();
      mount();
      const side = document.querySelector(`[data-pin-id="${SIDE.id}"][data-pin-from='list']`)!;
      fireEvent.pointerDown(side, { clientX: 20, clientY: 300, button: 0, pointerId: 3 });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
      fireEvent.pointerUp(screen.getByTestId("chats-home"), { clientX: 40, clientY: 40, pointerId: 3 });
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
      expect(title.style.maxWidth).toBe("min(34vw, 140px)");
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
