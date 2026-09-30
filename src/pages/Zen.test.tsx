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
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { getAgentList, getCliProjectsList, getToken } from "../api/client";
import { useServersStore } from "../stores/servers";
import { STUB_AGENTS, STUB_FILES } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

afterEach(() => cleanup());

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
    expect(back.style.borderRadius).toBe("50%");
    expect(files.style.width).toBe(back.style.width);
    expect(files.style.height).toBe(back.style.height);
    expect(files.style.borderRadius).toBe(back.style.borderRadius);
    expect(terminal.style.width).toBe(back.style.width);
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
});
