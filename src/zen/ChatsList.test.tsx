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

import { useFeedbackStore } from "../stores/feedback";
import { hostLabel, useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { SEARCH_BAR_REST_BOTTOM } from "./GlassSearchBar";
import { JOIN_NO_PROJECT } from "./agentRow";
import { STUB_AGENTS } from "./stubData";
import { OWNER_LIST_HOLD, useZenStore } from "./zenStore";

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
  useZenStore.setState({ pinnedIds: [], hiddenSidecarAddrs: [] });
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
    const serverBtn = screen.getByRole("button", { name: /Server / });
    expect(header.firstElementChild).toBe(serverBtn);
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

  it("the ticket icon shows the waiting count and opens the existing ticket tray", () => {
    seedServer();
    useFeedbackStore.setState({ waitingCount: 3, rows: [], isLoading: false, error: null });
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("tickets-badge").textContent).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: /Tickets, 3 waiting/ }));
    expect(screen.getByTestId("overlay-tickets")).not.toBeNull();
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
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentError: null,
      screen: "list",
      pinnedIds: [],
    });
    mount();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    expect(screen.queryByTestId("chats-pin-drop")).toBeNull();
    const row = screen.getByLabelText("STUB [STUB] not-a-real-agent-1");
    fireEvent.pointerDown(row, { clientX: 20, clientY: 200, button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // No pins yet: the hold-drag gets a temporary glass drop strip.
    const drop = screen.getByTestId("chats-pin-drop");
    expect(drop.className).toMatch(/k2-pin-drop/);
    expect(drop.textContent).toMatch(/Drop to pin/);
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
    expect(useZenStore.getState().pinnedIds).toEqual(["stub-not-a-real-agent-1"]);
    expect(screen.getByLabelText("Pinned [STUB] not-a-real-agent-1")).not.toBeNull();
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

    fireEvent.pointerDown(screen.getByLabelText("Pinned [STUB] not-a-real-agent-1"), {
      clientX: 40,
      clientY: 40,
      button: 0,
      pointerId: 2,
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerUp(screen.getByTestId("chats-home"), {
      clientX: 40,
      clientY: 400,
      pointerId: 2,
    });
    expect(useZenStore.getState().pinnedIds).toEqual([]);
    expect(screen.queryByLabelText("Pinned [STUB] not-a-real-agent-1")).toBeNull();
    expect(screen.queryByTestId("chats-pins")).toBeNull();
    vi.useRealTimers();
  });

  it("hold-drag a pin onto another pin reorders", () => {
    vi.useFakeTimers();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
    const a = STUB_AGENTS[0];
    const b = STUB_AGENTS[1];
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
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
    fireEvent.pointerUp(screen.getByTestId("chats-home"), {
      clientX: 30,
      clientY: 50,
      pointerId: 1,
    });
    expect(useZenStore.getState().pinnedIds).toEqual([b.id, a.id]);
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

  describe("swipe right to pin", () => {
    const A = STUB_AGENTS[0];
    const B = STUB_AGENTS[1];
    const ROW_W = 375;

    function setup(pinnedIds: string[] = []) {
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
      Element.prototype.hasPointerCapture = () => true;
      useZenStore.setState({
        agentSource: "stub",
        agents: STUB_AGENTS,
        agentError: null,
        screen: "list",
        agentId: "",
        pinnedIds,
      });
      mount();
      for (const a of STUB_AGENTS) {
        const wrap = document.querySelector(`[data-swipe-row="${a.id}"]`) as HTMLElement;
        wrap.getBoundingClientRect = () =>
          ({ left: 0, right: ROW_W, top: 0, bottom: 70, width: ROW_W, height: 70, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
      }
    }
    const row = (a: (typeof STUB_AGENTS)[number]) => screen.getByLabelText(`STUB ${a.name}`);
    const action = (a: (typeof STUB_AGENTS)[number]) => screen.getByTestId(`swipe-action-${a.id}`);
    const home = () => screen.getByTestId("chats-home");

    /** Pointer down on the row, move through the points, release. */
    function drag(a: (typeof STUB_AGENTS)[number], points: [number, number][], up = true) {
      fireEvent.pointerDown(row(a), { clientX: 20, clientY: 200, button: 0, pointerId: 7 });
      for (const [x, y] of points) {
        fireEvent.pointerMove(home(), { clientX: x, clientY: y, pointerId: 7 });
      }
      if (up) {
        const [x, y] = points[points.length - 1] ?? [20, 200];
        fireEvent.pointerUp(home(), { clientX: x, clientY: y, pointerId: 7 });
      }
    }

    it("a swipe right past the threshold reveals a round glass Pin button", () => {
      setup();
      drag(A, [[34, 201], [70, 202], [110, 203]]);
      const btn = action(A);
      expect(btn.style.width).toBe("76px");
      // The revealed strip is clear, not a yellow slab.
      expect(btn.style.background).toBe("transparent");
      const glass = btn.querySelector("[data-testid='swipe-action-glass']") as HTMLElement;
      expect(glass.className).toMatch(/k2-swipe-pin/);
      expect(glass.style.color).toBe("rgb(255, 214, 10)");
      expect(glass.style.transform).toBe("scale(1)");
      expect(
        (btn.querySelector("[data-testid='swipe-action-reveal']") as HTMLElement).style.opacity
      ).toBe("1");
      expect(btn.getAttribute("aria-label")).toBe(`Pin ${A.name}`);
      expect(btn.textContent).toBe("Pin");
      expect(glass.querySelector("[data-testid='pin-glyph']")).not.toBeNull();
      expect(row(A).style.transform).toBe("translateX(76px)");
      // The swipe's click does not open the chat.
      fireEvent.click(row(A));
      expect(useZenStore.getState().screen).toBe("list");
    });

    it("tapping the Pin button calls pinChat and closes the row", () => {
      setup();
      const pinChat = vi.fn();
      const orig = useZenStore.getState().pinChat;
      useZenStore.setState({ pinChat });
      onTestFinished(() => useZenStore.setState({ pinChat: orig }));
      drag(A, [[34, 200], [110, 200]]);
      fireEvent.pointerDown(action(A), { clientX: 30, clientY: 200, button: 0, pointerId: 8 });
      fireEvent.pointerUp(home(), { clientX: 30, clientY: 200, pointerId: 8 });
      fireEvent.click(action(A));
      expect(pinChat).toHaveBeenCalledWith(A.id);
      expect(action(A).style.width).toBe("0px");
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(row(A).style.transition).toMatch(/transform/);
    });

    it("the glass pin scales and fades in with the drag", () => {
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

    it("a short swipe springs back", () => {
      setup();
      drag(A, [[34, 200], [60, 200]]);
      expect(action(A).style.width).toBe("0px");
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(useZenStore.getState().pinnedIds).toEqual([]);
    });

    it("a vertical drag does not open the row", () => {
      setup();
      drag(A, [[24, 215], [28, 260], [30, 320]]);
      expect(action(A).style.width).toBe("0px");
      expect(row(A).style.transform).toBe("translateX(0px)");
      expect(screen.queryByTestId("pin-ghost")).toBeNull();
    });

    it("a full swipe pins at once with the glyph popped", () => {
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
      expect(useZenStore.getState().pinnedIds).toEqual([A.id]);
      expect(screen.getByLabelText(`Pinned ${A.name}`)).not.toBeNull();
      // First pin: the grid appears where there was none.
      expect(screen.getByTestId("chats-pins")).not.toBeNull();
      expect(row(A).style.transform).toBe("translateX(0px)");
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

    it("a pinned agent's row offers Unpin with a slashed pin", () => {
      setup([A.id]);
      drag(A, [[34, 200], [110, 200]]);
      expect(action(A).getAttribute("aria-label")).toBe(`Unpin ${A.name}`);
      expect(action(A).textContent).toBe("Unpin");
      expect(
        action(A).querySelector("[data-testid='swipe-action-glass'] [data-testid='unpin-glyph']")
      ).not.toBeNull();
      fireEvent.click(action(A));
      expect(useZenStore.getState().pinnedIds).toEqual([]);
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
    });

    it("rows point at the swipe hint for assistive tech", () => {
      setup();
      const hint = document.getElementById(row(A).getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toMatch(/Swipe right to pin/);
    });
  });
});
