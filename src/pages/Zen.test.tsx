// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
}));

import { getAgentList, getCliProjectsList, getToken } from "../api/client";
import { useServersStore } from "../stores/servers";
import { STUB_AGENTS } from "../zen/stubData";
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
});
