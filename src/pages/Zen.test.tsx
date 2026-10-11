// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => ""),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  inspectProjectsSummary: vi.fn(),
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

import { getAgentList, getAllSessions, getCliProjectsList, getToken, setSessionLabel, setTabTitle } from "../api/client";
import { useServersStore } from "../stores/servers";
import { STUB_AGENTS, STUB_FILES } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

afterEach(() => {
  cleanup();
  useZenStore.setState({ hiddenSidecarAddrs: [] });
});

beforeEach(() => {
  useServersStore.setState({
    servers: [
      {
        id: "s1",
        nickname: "test",
        url: "https://example.k2.dev",
        username: "u",
        rememberPassword: false,
      },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
});

describe("Zen keeps the chats list mounted", () => {
  it("chats-home stays in the document after opening a thread", async () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    expect(useZenStore.getState().screen).toBe("thread");
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("chats-layer").getAttribute("aria-hidden")).toBe(
        "true"
      )
    );
  });

  it("a live chat header is the agent name, not a LIVE agents tagline", async () => {
    vi.mocked(getToken).mockReturnValue("t");
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { name: "appa", path: "/ws", enabled: true, live: true, mode: "agent" },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/ws" }],
    });
    useZenStore.setState({
      agentSource: "live",
      fileSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
        },
      ],
      agentId: "/ws",
      screen: "thread",
      agentError: null,
      fileError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("live")
    );
    expect(screen.getAllByText("appa").length).toBeGreaterThan(0);
    expect(screen.queryByText(/LIVE agents/)).toBeNull();
    expect(screen.queryByTestId("chat-header-sub")).toBeNull();
  });

  it("a stub chat header still says STUB", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      fileSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    expect(screen.getByTestId("chat-header-sub").textContent).toMatch(
      /STUB — not live agents or files/
    );
  });

  it("thread header has Files and Terminal icons, no side View Files bar", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      filesOpen: false,
      agentError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    expect(screen.getByRole("button", { name: "Files" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Terminal" })).not.toBeNull();
    expect(screen.queryByText("⌁")).toBeNull();
    expect(screen.queryByLabelText(/View Files/i)).toBeNull();
    expect(screen.queryByTestId("file-pane")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("file-pane")).not.toBeNull();
  });

  it("?thread= opens that overlay chat after hydrate", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${STUB_AGENTS[0].id}`]}>
        <Zen />
      </MemoryRouter>
    );
    expect(screen.getByTestId("chats-layer").getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    await waitFor(() =>
      expect(useZenStore.getState().screen).toBe("thread")
    );
    expect(useZenStore.getState().agentId).toBe(STUB_AGENTS[0].id);
    expect(screen.getByRole("button", { name: "Terminal" })).not.toBeNull();
  });

  it("Back from a ?thread= entry shows the chats list, not an empty thread", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${STUB_AGENTS[0].id}`]}>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().screen).toBe("thread")
    );
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    const back = screen.getByTestId("chat-back");
    const files = screen.getByRole("button", { name: "Files" });
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(back.style.width).toBe("36px");
    expect(back.style.height).toBe("36px");
    expect(back.className).toMatch(/zen-glass/);
    expect(files.style.width).toBe(back.style.width);
    expect(files.style.height).toBe(back.style.height);
    expect(files.className).toMatch(/zen-glass/);
    expect(terminal.style.width).toBe(back.style.width);
    expect(terminal.className).toMatch(/zen-glass/);
    const headerContent = screen.getByTestId("chat-header-content");
    expect(headerContent.style.paddingTop).toBe("6px");
    expect(headerContent.style.paddingBottom).toBe("12px");
    fireEvent.click(back);
    expect(useZenStore.getState().screen).toBe("list");
    expect(useZenStore.getState().agentId).toBe("");
    expect(screen.queryByTestId("thread-column")).toBeNull();
    expect(screen.getByTestId("chats-layer").getAttribute("aria-hidden")).not.toBe(
      "true"
    );
    expect(screen.getByTestId("chats-home")).not.toBeNull();
  });

  it("Back from a list-opened thread still shows the chats list", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(useZenStore.getState().screen).toBe("list");
    expect(screen.queryByTestId("thread-column")).toBeNull();
    expect(screen.getByTestId("chats-layer").getAttribute("aria-hidden")).not.toBe(
      "true"
    );
  });

  it("?thread= first paint is loading, not leftover bubbles", async () => {
    vi.mocked(getToken).mockReturnValue("t");
    vi.mocked(getAgentList).mockReturnValue(new Promise(() => {}));
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
    useZenStore.setState({
      agentSource: "live",
      fileSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
        },
      ],
      agentId: "/ws",
      screen: "thread",
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "stale",
          seq: 1,
          text: "STALE BUBBLE",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
      agentError: null,
      fileError: null,
    });
    render(
      <MemoryRouter initialEntries={["/zen?thread=/ws"]}>
        <Zen />
      </MemoryRouter>
    );
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    expect(screen.getByTestId("thread-loading").textContent).toMatch(/LOADING thread/);
    expect(screen.queryByText("STALE BUBBLE")).toBeNull();
  });

  it("floats an iMessage header with the agent's avatar over a blurred, scrollable list", async () => {
    vi.mocked(getToken).mockReturnValue("");
    const withIcon = { ...STUB_AGENTS[0], color: "#123456", iconUrl: "https://example.k2.dev/icon.png" };
    useZenStore.setState({
      agentSource: "stub",
      agents: [withIcon, ...STUB_AGENTS.slice(1)],
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${withIcon.id}`]}>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    // Stub hydration replaces the rows; put the iconed row back.
    act(() => {
      useZenStore.setState({ agents: [withIcon, ...STUB_AGENTS.slice(1)], agentId: withIcon.id });
    });
    const header = screen.getByTestId("chat-header");
    // Floats from y=0 over the list; the column no longer pads the safe area.
    expect(header.className).toMatch(/absolute/);
    expect(header.style.pointerEvents).toBe("none");
    expect(screen.getByTestId("thread-column").style.paddingTop).toBe("");

    // Desktop workspace icon above the name.
    const avatar = screen.getByTestId("chat-header-avatar");
    const img = avatar.querySelector("img");
    expect(img?.getAttribute("src")).toBe(withIcon.iconUrl);
    expect(
      avatar.compareDocumentPosition(screen.getByTestId("chat-header-title")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Progressive blur: four masked blur layers plus a dark tint, all inert.
    const blur = screen.getByTestId("chat-header-blur");
    expect(blur.className).toMatch(/zen-header-blur/);
    // The early (Agents list) blur stays on the Agents header only.
    expect(blur.className).not.toMatch(/zen-header-blur--early/);
    expect(header.contains(blur)).toBe(true);
    expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
    expect(blur.querySelector(".zen-header-tint")).not.toBeNull();
    // Controls still take touches through the inert header box.
    expect(screen.getByTestId("chat-back").style.pointerEvents).toBe("auto");
    expect(
      (screen.getByRole("button", { name: "Files" }).parentElement as HTMLElement).style
        .pointerEvents
    ).toBe("auto");

    // First message starts below the header at rest.
    const pad = screen.getByTestId("thread-scroller").style.paddingTop;
    expect(pad).toMatch(/env\(safe-area-inset-top\)/);
    expect(pad).toMatch(/92px/);
  });

  it("falls back to the agent's coloured initial when there is no icon", async () => {
    vi.mocked(getToken).mockReturnValue("");
    const plain = { ...STUB_AGENTS[0], initial: "Q", color: "#654321", iconUrl: null };
    useZenStore.setState({
      agentSource: "stub",
      agents: [plain],
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${plain.id}`]}>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    act(() => {
      useZenStore.setState({ agents: [plain], agentId: plain.id });
    });
    const avatar = screen.getByTestId("chat-header-avatar");
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("Q");
    const disc = avatar.firstElementChild as HTMLElement;
    expect(disc.style.width).toBe("42px");
    expect(disc.style.background).toMatch(/rgb\(101, 67, 33\)|#654321/);
  });

  it("sizes the thread column to the visible height above the iOS keyboard", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${STUB_AGENTS[0].id}`]}>
        <Zen />
      </MemoryRouter>
    );
    const home = screen.getByTestId("thread-home");
    expect(home.style.position).toBe("fixed");
    const column = screen.getByTestId("thread-column");
    expect(column.style.height).toBe(`${window.innerHeight}px`);
    expect(column.className).not.toMatch(/h-full/);
    // Header and composer live inside the sized column.
    expect(column.contains(screen.getByTestId("chat-header"))).toBe(true);
    expect(column.contains(screen.getByTestId("composer-form"))).toBe(true);

    const open = window.innerHeight - 336;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("k2-viewport-resize", { detail: { height: open } })
      );
    });
    expect(screen.getByTestId("thread-column").style.height).toBe(`${open}px`);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("k2-viewport-resize", {
          detail: { height: window.innerHeight },
        })
      );
    });
    expect(screen.getByTestId("thread-column").style.height).toBe(
      `${window.innerHeight}px`
    );
  });

  it("tapping the visible chat while a file is open closes the file pane", async () => {
    vi.mocked(getToken).mockReturnValue("");
    useZenStore.setState({
      agentSource: "stub",
      fileSource: "stub",
      agents: STUB_AGENTS,
      files: STUB_FILES,
      screen: "list",
      agentError: null,
      fileError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
      useZenStore.setState({
        files: STUB_FILES,
        fileSource: "stub",
        filesOpen: true,
        openFileIds: [STUB_FILES[0].id],
        focusId: STUB_FILES[0].id,
      });
    });
    expect(screen.getByTestId("file-stage")).not.toBeNull();
    fireEvent.click(screen.getByTestId("thread-column"));
    expect(useZenStore.getState().openFileIds).toEqual([]);
    expect(useZenStore.getState().filesOpen).toBe(false);
    expect(screen.queryByTestId("file-stage")).toBeNull();
  });

  it("an extra chat header is the workspace name with the sidecar title under it", async () => {
    vi.mocked(getToken).mockReturnValue("");
    const sess = {
      cwd: "/ws",
      workspaceName: "Skin Test A",
      workspaceId: "skin-test-a",
      workspaceColor: "#000",
      agentName: "qa088",
      terminalId: "tid-qa088",
      label: "Example Sidecar",
      isMainChat: false,
      tabId: "tab-qa088",
      projectId: "proj-skin",
    };
    vi.mocked(getAllSessions)
      .mockResolvedValueOnce({ ok: true, data: [sess] })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ ...sess, label: "notes" }],
      });
    vi.mocked(setSessionLabel).mockResolvedValue({ ok: true, data: { success: true } });
    vi.mocked(setTabTitle).mockResolvedValue({ ok: true, data: { success: true } });
    const extra = {
      id: "/ws::skin-test-a/qa088",
      name: "Skin Test A",
      initial: "ST",
      path: "/ws",
      addr: "skin-test-a/qa088",
      chatTitle: "Example Sidecar",
      joinMiss: null,
      kind: "agent" as const,
      tabId: "tab-qa088",
      projectId: "proj-skin",
      terminalId: "tid-qa088",
    };
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.setState({
        agentSource: "live",
        agents: [extra],
        screen: "thread",
        agentId: extra.id,
        agentError: null,
        thread: [],
        threadSource: "live",
      });
    });
    expect(screen.getByTestId("chat-header-title").textContent).toBe("Skin Test A");
    expect(screen.getByTestId("chat-sidecar-title").textContent).toBe("Example Sidecar");
    expect(screen.getByTestId("chat-rename-open")).not.toBeNull();
    expect(screen.getByTestId("chat-hide")).not.toBeNull();
    // The session name sits under the three right-hand buttons, right
    // aligned and white; the centre column holds only avatar + name.
    const right = screen.getByTestId("chat-header-right");
    const line = screen.getByTestId("chat-session-line");
    expect(right.contains(line)).toBe(true);
    expect(right.contains(screen.getByTestId("chat-rename-open"))).toBe(true);
    expect(right.firstElementChild).toBe(screen.getByTestId("chat-header-buttons"));
    expect(
      screen.getByTestId("chat-header-buttons").compareDocumentPosition(line) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(right.className).toContain("items-end");
    expect(line.className).toContain("justify-end");
    expect(
      screen.getByTestId("chat-header-title").parentElement?.contains(line)
    ).toBe(false);
    expect(screen.getByTestId("chat-sidecar-title").style.color).toBe("rgb(255, 255, 255)");
    expect(screen.getByTestId("chat-rename-open").style.color).toBe("rgb(255, 255, 255)");
    fireEvent.click(screen.getByTestId("chat-rename-open"));
    expect(screen.getByTestId("chat-rename-input")).not.toBeNull();
    fireEvent.change(screen.getByTestId("chat-rename-input"), {
      target: { value: "notes" },
    });
    fireEvent.click(screen.getByTestId("chat-rename-save"));
    await waitFor(() => {
      expect(useZenStore.getState().agents[0]?.chatTitle).toBe("notes");
    });
    expect(setSessionLabel).toHaveBeenCalledWith("tid-qa088", "notes");
    expect(setTabTitle).toHaveBeenCalledWith("proj-skin", "tab-qa088", "notes");
    fireEvent.click(screen.getByTestId("chat-hide"));
    expect(useZenStore.getState().screen).toBe("list");
  });

  it("keeps the rename sheet open when K2 does not take the name", async () => {
    vi.mocked(getToken).mockReturnValue("");
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          cwd: "/ws",
          workspaceName: "Skin Test A",
          workspaceId: "skin-test-a",
          workspaceColor: "#000",
          agentName: "qa088",
          terminalId: "tid-qa088",
          label: "qa088",
          isMainChat: false,
          tabId: "tab-qa088",
          projectId: "proj-skin",
        },
      ],
    });
    vi.mocked(setSessionLabel).mockResolvedValue({ ok: false, error: "locked" });
    vi.mocked(setTabTitle).mockResolvedValue({ ok: false, error: "locked" });
    const extra = {
      id: "/ws::skin-test-a/qa088",
      name: "Skin Test A",
      initial: "ST",
      path: "/ws",
      addr: "skin-test-a/qa088",
      chatTitle: "qa088",
      joinMiss: null,
      kind: "agent" as const,
      tabId: "tab-qa088",
      projectId: "proj-skin",
      terminalId: "tid-qa088",
    };
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.setState({
        agentSource: "live",
        agents: [extra],
        screen: "thread",
        agentId: extra.id,
        agentError: null,
        thread: [],
        threadSource: "live",
      });
    });
    fireEvent.click(screen.getByTestId("chat-rename-open"));
    fireEvent.change(screen.getByTestId("chat-rename-input"), {
      target: { value: "notes" },
    });
    fireEvent.click(screen.getByTestId("chat-rename-save"));
    await waitFor(() => {
      expect(screen.getByTestId("chat-rename-error").textContent).toBe("locked");
    });
    expect(useZenStore.getState().agents[0]?.chatTitle).toBe("qa088");
    expect(screen.getByTestId("chat-rename")).not.toBeNull();
  });

  it("main chat header is the workspace name with no Hide", async () => {
    vi.mocked(getToken).mockReturnValue("");
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    act(() => {
      useZenStore.setState({
        agentSource: "live",
        agents: [
          {
            id: "/ws::skin-test-a",
            name: "Skin Test A",
            initial: "ST",
            path: "/ws",
            addr: "skin-test-a",
            chatTitle: null,
            joinMiss: null,
            kind: "agent",
          },
        ],
        screen: "thread",
        agentId: "/ws::skin-test-a",
        agentError: null,
        thread: [],
        threadSource: "live",
      });
    });
    expect(screen.getByTestId("chat-header-title").textContent).toBe("Skin Test A");
    expect(screen.queryByTestId("chat-sidecar-title")).toBeNull();
    expect(screen.queryByTestId("chat-rename-open")).toBeNull();
    expect(screen.queryByTestId("chat-hide")).toBeNull();
  });
});

describe("Zen thread terminal button", () => {
  it("opens the glass Zen terminal page with the agent in router state", async () => {
    const { Routes, Route, useLocation } = await import("react-router-dom");
    const { readZenThread } = await import("../zen/terminalJump");
    function TermLoc() {
      const loc = useLocation();
      const st = loc.state as { agent?: { agentId: string; name: string; color?: string } } | null;
      return (
        <div data-testid="term-loc">
          {`${loc.pathname}|${st?.agent?.agentId}|${st?.agent?.name}|${st?.agent?.color}`}
        </div>
      );
    }
    vi.mocked(getToken).mockReturnValue("");
    const appa = { ...STUB_AGENTS[0], path: "/ws/appa", addr: "appa", color: "#123456" };
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          terminalId: "t-main",
          cwd: "/ws/appa",
          isMainChat: true,
          workspaceName: "appa",
          workspaceId: "w",
          workspaceColor: "#000",
          agentName: "appa",
          label: "main",
        },
      ],
    } as never);
    useZenStore.setState({ agentSource: "stub", agents: [appa], screen: "list", agentError: null });
    render(
      <MemoryRouter initialEntries={[`/zen?thread=${appa.id}`]}>
        <Routes>
          <Route path="/zen" element={<Zen />} />
          <Route path="/zen/terminal/:terminalId" element={<TermLoc />} />
          <Route path="*" element={<div data-testid="term-loc">elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    act(() => {
      useZenStore.setState({ agents: [appa], agentId: appa.id });
    });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(screen.getByTestId("term-loc")).not.toBeNull());
    expect(screen.getByTestId("term-loc").textContent).toBe(
      `/zen/terminal/t-main|${appa.id}|${appa.name}|#123456`
    );
    expect(readZenThread()).toBe(appa.id);
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] } as never);
  });
});
