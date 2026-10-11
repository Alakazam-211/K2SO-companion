// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
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

  it("the + button opens the overlay add form; no header Add button", () => {
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).not.toBeNull();
    const plus = screen.getByRole("button", { name: "Add server" });
    expect(plus.className).toMatch(/zen-glass-round/);
    fireEvent.click(plus);
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

  it("lists the active server first, then the rest alphabetically", () => {
    useServersStore.setState({
      servers: [
        { ...OTHER, id: "s3", nickname: "zulu" },
        HOME,
        { ...OTHER, id: "s4", nickname: "", url: "https://bravo.k2.dev" },
        OTHER,
        { ...OTHER, id: "s5", nickname: "alpha" },
      ],
      activeServerId: "s2",
      recovery: { s1: "connected", s2: "connected", s3: "connected", s4: "connected", s5: "connected" },
    });
    render(<OverlayServers onClose={() => {}} />);
    const names = screen
      .getAllByTestId("overlay-server-row")
      .map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Other", "alpha", "bravo.k2.dev", "Home", "zulu"]);
    expect(screen.getByText("active").closest("[data-testid=overlay-servers-list] > div")?.textContent).toMatch(/^Other/);
  });

  it("search filters by nickname, host, or username, case-insensitively", () => {
    useServersStore.setState({
      servers: [HOME, OTHER, { ...OTHER, id: "s3", nickname: "Lab", url: "https://lab.k2.dev", username: "jeremie" }],
      activeServerId: "s1",
      recovery: { s1: "connected", s2: "connected", s3: "connected" },
    });
    render(<OverlayServers onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Search servers");
    const rows = () =>
      screen.getAllByTestId("overlay-server-row").map((el) => el.getAttribute("aria-label"));

    fireEvent.change(input, { target: { value: "oTH" } });
    expect(rows()).toEqual(["Other"]);

    fireEvent.change(input, { target: { value: "LAB.K2" } });
    expect(rows()).toEqual(["Lab"]);

    fireEvent.change(input, { target: { value: "JEREMIE" } });
    expect(rows()).toEqual(["Lab"]);

    // Active server stays first when it matches.
    fireEvent.change(input, { target: { value: "baden" } });
    expect(rows()).toEqual(["Home", "Other"]);

    fireEvent.change(input, { target: { value: "" } });
    expect(rows()).toEqual(["Home", "Lab", "Other"]);
  });

  it("shows an empty state when no server matches", () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search servers"), {
      target: { value: "nothing-here" },
    });
    expect(screen.queryAllByTestId("overlay-server-row")).toHaveLength(0);
    expect(screen.getByText("No servers match")).not.toBeNull();
  });

  it("the list leaves room for the bottom bar", () => {
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.getByTestId("overlay-servers-list").style.paddingBottom).toBe("96px");
    expect(screen.getByTestId("overlay-servers-bar").className).toMatch(/absolute/);
  });
});
