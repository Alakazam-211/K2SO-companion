// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { JUST_CONNECTED_MS, OverlayServers, SERVERS_HEADER_PX } from "./OverlayServers";
import { useZenStore } from "./zenStore";
import { useMultiServerPrefs } from "./multi/prefs";
import { blankEntry, pool } from "./multi/pool";

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const listRows = () =>
  screen.getAllByTestId("overlay-server-row").map((el) => el.getAttribute("aria-label"));

/** Let the mocked connect / hydrate promises settle under fake timers. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

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
  it("MS38: with multi-server on, other servers show their pool state; the pinned card says Default", () => {
    useMultiServerPrefs.setState({ multiServer: true });
    pool.store.setState({
      entries: { s2: { ...blankEntry("s2", "other.k2.dev"), reach: "offline", offlineStreak: 1 } },
    });
    try {
      render(<OverlayServers onClose={() => {}} />);
      expect(screen.getByTestId("servers-pinned-label").textContent).toBe(
        "Default server (Tickets, classic view)"
      );
      expect(screen.getByTestId("overlay-server-state").textContent).toBe("Offline");
    } finally {
      useMultiServerPrefs.setState({ multiServer: false });
      pool.forget("s2");
    }
  });

  it("flag off: the old recovery words, no Default label", () => {
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.queryByTestId("servers-pinned-label")).toBeNull();
    expect(screen.getByTestId("overlay-server-state").textContent).toBe("connected");
  });

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
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: JUST_CONNECTED_MS + 1500 });
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

  it("pins the active server above the scroller; the list holds the others A-Z", () => {
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
    const pinned = screen.getByTestId("servers-pinned");
    const list = screen.getByTestId("overlay-servers-list");
    expect(list.contains(pinned)).toBe(false);
    expect(within(pinned).getByRole("button", { name: "Other" })).not.toBeNull();
    expect(within(pinned).getByText("Connected")).not.toBeNull();
    expect(within(pinned).getByRole("button", { name: "Edit Other" })).not.toBeNull();
    expect(listRows()).toEqual(["alpha", "bravo.k2.dev", "Home", "zulu"]);
  });

  it("with no active server there is no pinned card", () => {
    useServersStore.setState({ activeServerId: null });
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.queryByTestId("servers-pinned")).toBeNull();
    expect(listRows()).toEqual(["Home", "Other"]);
  });

  it("a successful switch pins the new server and highlights it until the animation ends", async () => {
    vi.useFakeTimers();
    vi.mocked(connectServer).mockResolvedValue("revived");
    const hydrateAgents = vi.fn(async () => {});
    useZenStore.setState({ hydrateAgents });
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await flush();

    const pinned = screen.getByTestId("servers-pinned");
    expect(within(pinned).getByRole("button", { name: "Other" })).not.toBeNull();
    const card = pinned.querySelector("[data-just-connected]");
    expect(card?.getAttribute("data-just-connected")).toBe("true");
    expect(within(pinned).getByTestId("servers-pinned-check")).not.toBeNull();
    // The previous server is back in the list.
    expect(listRows()).toEqual(["Home"]);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(JUST_CONNECTED_MS);
    });
    await flush();
    expect(pinned.querySelector("[data-just-connected]")).toBeNull();
    expect(screen.queryByTestId("servers-pinned-check")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed switch shows no highlight", async () => {
    vi.mocked(connectServer).mockResolvedValue("unreachable");
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(connectServer).toHaveBeenCalledWith("s2"));
    await flush();
    expect(document.querySelector("[data-just-connected]")).toBeNull();
    expect(within(screen.getByTestId("servers-pinned")).getByRole("button", { name: "Home" })).not.toBeNull();
  });

  it("search filters only the list (nickname, host, username); the pinned card stays", () => {
    useServersStore.setState({
      servers: [HOME, OTHER, { ...OTHER, id: "s3", nickname: "Lab", url: "https://lab.k2.dev", username: "jeremie" }],
      activeServerId: "s1",
      recovery: { s1: "connected", s2: "connected", s3: "connected" },
    });
    render(<OverlayServers onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Search servers");
    const pinnedHome = () =>
      within(screen.getByTestId("servers-pinned")).getByRole("button", { name: "Home" });

    fireEvent.change(input, { target: { value: "oTH" } });
    expect(listRows()).toEqual(["Other"]);
    expect(pinnedHome()).not.toBeNull();

    fireEvent.change(input, { target: { value: "LAB.K2" } });
    expect(listRows()).toEqual(["Lab"]);

    fireEvent.change(input, { target: { value: "JEREMIE" } });
    expect(listRows()).toEqual(["Lab"]);
    expect(pinnedHome()).not.toBeNull();

    // The active server is never a list row, even when it matches.
    fireEvent.change(input, { target: { value: "baden" } });
    expect(listRows()).toEqual(["Other"]);

    fireEvent.change(input, { target: { value: "home" } });
    expect(screen.queryAllByTestId("overlay-server-row")).toHaveLength(0);
    expect(screen.getByText("No servers match")).not.toBeNull();
    expect(pinnedHome()).not.toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(listRows()).toEqual(["Lab", "Other"]);
  });

  it("shows an empty state when no server matches", () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search servers"), {
      target: { value: "nothing-here" },
    });
    expect(screen.queryAllByTestId("overlay-server-row")).toHaveLength(0);
    expect(screen.getByText("No servers match")).not.toBeNull();
  });

  it("header floats over the list with the progressive blur; the pinned card rides in it", () => {
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    const header = screen.getByTestId("servers-header");
    expect(header.className).toMatch(/absolute/);
    expect(header.style.pointerEvents).toBe("none");
    expect(screen.getByTestId("overlay-servers").style.paddingTop).toBe("");

    const blur = screen.getByTestId("servers-header-blur");
    expect(header.contains(blur)).toBe(true);
    expect(blur.className).toBe("zen-header-blur");
    expect(blur.style.pointerEvents).toBe("none");
    expect(blur.getAttribute("aria-hidden")).not.toBeNull();
    expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
    expect(blur.querySelector(".zen-header-tint")).not.toBeNull();

    // Title and pinned card float; only Done and the card take touches.
    const pinned = screen.getByTestId("servers-pinned");
    expect(header.contains(pinned)).toBe(true);
    const card = within(pinned).getByRole("button", { name: "Home" }).parentElement!;
    expect(card.style.pointerEvents).toBe("auto");
    const done = within(header).getByRole("button", { name: "Done" });
    expect(done.style.pointerEvents).toBe("auto");
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);

    // The list starts under the header and card (jsdom measures 0, so the
    // resting height) and scrolls up behind both.
    const list = screen.getByTestId("overlay-servers-list");
    expect(header.contains(list)).toBe(false);
    expect(list.style.paddingTop).toMatch(/env\(safe-area-inset-top\)/);
    const pad = Number(list.style.paddingTop.match(/(\d+)px/)![1]);
    expect(pad).toBeGreaterThan(SERVERS_HEADER_PX);
  });

  it("with no pinned card the list pads by the title row only", () => {
    useServersStore.setState({ activeServerId: null });
    render(<OverlayServers onClose={() => {}} />);
    const pad = screen.getByTestId("overlay-servers-list").style.paddingTop;
    expect(pad).toMatch(/env\(safe-area-inset-top\)/);
    expect(pad).toContain(`${SERVERS_HEADER_PX}px`);
  });

  it("the edit form replaces the sheet and Cancel brings the floating header back", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    expect(screen.queryByTestId("servers-header")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.getByTestId("servers-header-blur")).not.toBeNull();
  });

  it("the list leaves room for the bottom bar", () => {
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.getByTestId("overlay-servers-list").style.paddingBottom).toBe("96px");
    expect(screen.getByTestId("overlay-servers-bar").className).toMatch(/absolute/);
  });
});
