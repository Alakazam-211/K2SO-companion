// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getFsReadDir: vi.fn(async () => ({ ok: true, data: [] })),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(async () => ({ ok: true, data: { items: [] } })),
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

import { getAgentList, getAllSessions, getCliProjectsList, spawnSidecarSession } from "../api/client";
import { OverlayCompose } from "./OverlayCompose";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

const LIVE_AGENT = {
  id: "/ws",
  name: "appa",
  initial: "A",
  path: "/ws",
  addr: "appa",
  joinMiss: null,
  kind: "agent" as const,
  mode: "custom",
  enabled: true,
  live: true,
};

const GROUP = {
  id: "g1",
  name: "K2 Companion",
  initial: "K",
  path: "/g",
  addr: null,
  joinMiss: null,
  kind: "group" as const,
  groupId: "g1",
  memberCount: 3,
};

describe("OverlayCompose", () => {
  it("a group opens immediately, without the main-vs-sidecar ask", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [GROUP, LIVE_AGENT],
      screen: "list",
      agentId: "",
    });
    const onClose = () => {};
    render(<OverlayCompose onClose={onClose} />);
    fireEvent.click(screen.getByText("K2 Companion"));
    expect(screen.queryByTestId("compose-ask")).toBeNull();
    expect(useZenStore.getState().agentId).toBe("g1");
    expect(useZenStore.getState().screen).toBe("thread");
  });

  it("an agent asks main chat vs a separate chat", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [LIVE_AGENT],
      screen: "list",
      agentId: "",
    });
    render(<OverlayCompose onClose={() => {}} />);
    fireEvent.click(screen.getByText("appa"));
    expect(screen.getByTestId("compose-ask")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Main chat" }));
    expect(useZenStore.getState().agentId).toBe("/ws");
    expect(useZenStore.getState().screen).toBe("thread");
  });

  it("separate chat spawns the next unused sidecar, not always /1", async () => {
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: true,
      data: { sessionId: "sid-2", agentName: "2" },
    });
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [{ name: "appa", path: "/ws", enabled: true, live: true, mode: "custom" }],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/ws" }],
    });
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        { cwd: "/ws", agentName: "1", label: "1", isMainChat: false },
        { cwd: "/ws", agentName: "2", label: "2", isMainChat: false },
      ] as never,
    });
    useZenStore.setState({
      agentSource: "live",
      agents: [
        LIVE_AGENT,
        {
          ...LIVE_AGENT,
          id: "/ws::appa/1",
          addr: "appa/1",
          chatTitle: "1",
        },
      ],
      screen: "list",
      agentId: "",
    });
    const onClose = vi.fn();
    render(<OverlayCompose onClose={onClose} />);
    fireEvent.click(screen.getByText("appa"));
    fireEvent.click(screen.getByRole("button", { name: "Separate chat" }));
    await waitFor(() => expect(spawnSidecarSession).toHaveBeenCalledWith("/ws", "2", "2"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const s = useZenStore.getState();
    expect(s.agents.some((a) => a.addr === "appa/2" && a.name === "appa")).toBe(true);
    expect(s.agents.some((a) => a.name === "appa / 1" || a.name === "appa / 2")).toBe(false);
    expect(s.screen).toBe("thread");
  });

  it("separate chat surfaces a spawn failure instead of inventing a row", async () => {
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: false,
      error: "unknown overlay addr 'ai-trading-platform/1'",
    });
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/trade",
          name: "AI Trading Platform",
          initial: "A",
          path: "/trade",
          addr: "ai-trading-platform",
          joinMiss: null,
          kind: "agent" as const,
        },
      ],
      screen: "list",
      agentId: "",
    });
    const onClose = vi.fn();
    render(<OverlayCompose onClose={onClose} />);
    fireEvent.click(screen.getByText("AI Trading Platform"));
    fireEvent.click(screen.getByRole("button", { name: "Separate chat" }));
    await waitFor(() => expect(screen.getByTestId("compose-sidecar-error")).not.toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(useZenStore.getState().agents.some((a) => a.addr === "ai-trading-platform/1")).toBe(
      false
    );
  });
});
