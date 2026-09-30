// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
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
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(),
}));

import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { OverlayServers } from "./OverlayServers";
import { useZenStore } from "./zenStore";

const HOME = {
  id: "s1",
  nickname: "Home",
  url: "https://home.k2.dev",
  username: "baden",
  rememberPassword: false,
};
const OTHER = {
  id: "s2",
  nickname: "Other",
  url: "https://other.k2.dev",
  username: "baden",
  rememberPassword: false,
};

afterEach(() => cleanup());

beforeEach(() => {
  useServersStore.setState({
    servers: [HOME, OTHER],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t", s2: "t2" },
    recovery: { s1: "connected", s2: "connected" },
  });
});

describe("OverlayServers", () => {
  it("lists stored servers inside the overlay", () => {
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Servers" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Other" })).not.toBeNull();
    expect(screen.getByText("baden @ home.k2.dev")).not.toBeNull();
  });

  it("tapping a connected server reconnects, hydrates, and closes", async () => {
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    const hydrateAgents = vi.fn(async () => {});
    useZenStore.setState({ hydrateAgents });
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(connectServer).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(hydrateAgents).toHaveBeenCalled());
    expect(useServersStore.getState().activeServerId).toBe("s2");
    expect(onClose).toHaveBeenCalled();
  });

  it("signin-required opens the overlay add/edit form, not /login", async () => {
    vi.mocked(connectServer).mockResolvedValue("signin-required");
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(screen.getByTestId("overlay-add-server")).not.toBeNull());
    expect(screen.getByText("Edit server")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Add opens the overlay add form", () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.getByText("Add server")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
  });

  it("cancelling a sign-in-required pick leaves the previous server active", async () => {
    vi.mocked(connectServer).mockResolvedValue("signin-required");
    const hydrateAgents = vi.fn(async () => {});
    useZenStore.setState({ hydrateAgents });
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(screen.getByTestId("overlay-add-server")).not.toBeNull());
    expect(useServersStore.getState().activeServerId).toBe("s1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useServersStore.getState().activeServerId).toBe("s1");
    expect(hydrateAgents).not.toHaveBeenCalled();
  });

  it("an unreachable pick does not change the active server", async () => {
    vi.mocked(connectServer).mockResolvedValue("unreachable");
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(connectServer).toHaveBeenCalledWith("s2"));
    expect(useServersStore.getState().activeServerId).toBe("s1");
  });
});
