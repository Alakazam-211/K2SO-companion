// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
}));

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

  it("separate chat opens a sidecar named with / 1", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [LIVE_AGENT],
      screen: "list",
      agentId: "",
    });
    render(<OverlayCompose onClose={() => {}} />);
    fireEvent.click(screen.getByText("appa"));
    fireEvent.click(screen.getByRole("button", { name: "Separate chat" }));
    const s = useZenStore.getState();
    expect(s.agents.some((a) => a.addr === "appa/1" && a.name === "appa / 1")).toBe(
      true
    );
    expect(s.agentId).toBe("/ws::sidecar-1");
    expect(s.screen).toBe("thread");
  });
});
