// @vitest-environment jsdom
// The Agents header's 3-dot More menu: Rooms (voice), the in-call signal on
// the button, and the recording notice still opening Rooms by itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "./multi/prefs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  inspectProjectsSummary: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
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
  createWorkspace: vi.fn(),
  getFsInfo: vi.fn(async () => ({ ok: true, data: { home: "/Users/r" } })),
  updateProjectLook: vi.fn(),
  ensurePinnedChat: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(async () => "still-valid"),
}));

// The real Rooms sheet is covered by VoiceRooms.test; here only who opens it.
vi.mock("./voice/VoiceRooms", async (orig) => ({
  ...(await orig<typeof import("./voice/VoiceRooms")>()),
  VoiceRoomsOverlay: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="overlay-voice">
      <button type="button" onClick={onClose}>
        Close rooms
      </button>
    </div>
  ),
}));

import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { badgeText, moreAriaLabel, moreBadge } from "./HeaderMoreMenu";
import { STUB_AGENTS } from "./stubData";
import { useVoiceCall, type ConsentSheet } from "./voice/voiceCall";
import { useZenStore } from "./zenStore";

const NO_TICKETS = { waiting: 0, mine: 0, all: 0 };

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

const openMore = () => fireEvent.click(screen.getByTestId("chats-header-more"));

const menuIds = () =>
  Array.from(screen.getByTestId("chats-more-menu").querySelectorAll("[role=menuitem]")).map((i) =>
    i.getAttribute("data-testid")
  );

beforeEach(() => {
  useMultiServerPrefs.setState({ multiServer: false });
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list", projectsOpen: false });
  useVoiceCall.setState({ phase: "idle", consent: null });
});

afterEach(() => {
  cleanup();
  useVoiceCall.setState({ phase: "idle", consent: null });
});

describe("More menu: Rooms", () => {
  it("no call and no voice server: no Rooms row, no green dot", () => {
    mount();
    expect(screen.getByTestId("chats-header-more").getAttribute("aria-label")).toBe("More");
    expect(screen.queryByTestId("chats-header-more-call")).toBeNull();
    openMore();
    expect(menuIds()).toEqual(["chats-header-projects", "chats-header-tickets", "chats-header-settings"]);
  });

  it("in a call: a green dot on the button, Rooms first and green, and it opens Rooms", () => {
    useVoiceCall.setState({ phase: "connected" });
    mount();
    const more = screen.getByTestId("chats-header-more");
    expect(more.getAttribute("aria-label")).toBe("More, in a call");
    const dot = screen.getByTestId("chats-header-more-call");
    expect(more.contains(dot)).toBe(true);
    expect(dot.style.background).toMatch(/#30d158|rgb\(48,\s*209,\s*88\)/);

    openMore();
    expect(menuIds()).toEqual([
      "chats-header-voice",
      "chats-header-projects",
      "chats-header-tickets",
      "chats-header-settings",
    ]);
    const rooms = screen.getByRole("menuitem", { name: "Rooms (in a call)" });
    expect(rooms.getAttribute("data-testid")).toBe("chats-header-voice");
    expect(rooms.style.color).toMatch(/#30d158|rgb\(48,\s*209,\s*88\)/);
    fireEvent.click(rooms);
    expect(screen.queryByTestId("chats-more-menu")).toBeNull();
    expect(screen.getByTestId("overlay-voice")).not.toBeNull();
  });

  it("the call ending takes the dot away", () => {
    useVoiceCall.setState({ phase: "joining" });
    mount();
    expect(screen.getByTestId("chats-header-more-call")).not.toBeNull();
    act(() => useVoiceCall.setState({ phase: "idle" }));
    expect(screen.queryByTestId("chats-header-more-call")).toBeNull();
    expect(screen.getByTestId("chats-header-more").getAttribute("aria-label")).toBe("More");
  });

  it("a recording notice still opens Rooms by itself, and closes an open More menu", () => {
    useVoiceCall.setState({ phase: "connected" });
    mount();
    openMore();
    expect(screen.getByTestId("chats-more-menu")).not.toBeNull();
    const sheet: ConsentSheet = {
      ask: "in_call",
      recordingId: "r1",
      noticeVersion: 1,
      title: "Recording",
      text: "This call is being recorded.",
      choices: [{ label: "OK", granted: true }],
    };
    act(() => useVoiceCall.setState({ consent: sheet }));
    expect(screen.getByTestId("overlay-voice")).not.toBeNull();
    expect(screen.queryByTestId("chats-more-menu")).toBeNull();
  });
});

describe("More button helpers", () => {
  it("badge: project chats plus tickets; amber with tickets, blue without", () => {
    expect(moreBadge(0, null)).toBeNull();
    expect(moreBadge(2, null)).toEqual({ count: 2, tone: "projects" });
    expect(moreBadge(0, { count: 3, tone: "mine" })).toEqual({ count: 3, tone: "tickets" });
    expect(moreBadge(2, { count: 3, tone: "others" })).toEqual({ count: 5, tone: "tickets" });
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });

  it("label says the call and each count", () => {
    expect(moreAriaLabel({ inCall: false, projectsUnread: 0, tickets: NO_TICKETS })).toBe("More");
    expect(moreAriaLabel({ inCall: true, projectsUnread: 1, tickets: { waiting: 1, mine: 0, all: 4 } })).toBe(
      "More, in a call, 1 project chat unread, 1 ticket waiting on you"
    );
    expect(moreAriaLabel({ inCall: false, projectsUnread: 3, tickets: { waiting: 0, mine: 0, all: 2 } })).toBe(
      "More, 3 project chats unread, 2 tickets waiting"
    );
  });
});
