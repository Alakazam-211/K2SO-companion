// @vitest-environment jsdom
// The Chats list stays mounted (hidden) behind an open chat: the keyboard
// moving in that chat must not re-render it every step, only once it has
// settled. On screen it follows the viewport as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "./multi/prefs";
import { act, cleanup, render } from "@testing-library/react";
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

const renders = vi.hoisted(() => ({ list: 0 }));
vi.mock("../kit/mobileChat/useKeyboardFlip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kit/mobileChat/useKeyboardFlip")>();
  return {
    ...actual,
    // Once per ChatsList render.
    useKeyboardFlip: (...args: Parameters<typeof actual.useKeyboardFlip>) => {
      renders.list++;
      return actual.useKeyboardFlip(...args);
    },
  };
});

vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => ({ username: "u", owner: true, role: "owner" }),
}));

import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { useHomesStore } from "./homes";
import { useRecentFirstStore } from "./recentFirst";
import { FOCUS_OFF } from "./serverPins";
import { useZenStore } from "./zenStore";
import { __resetViewportForTests } from "../lib/useViewportHeight";

const agent = (id: string, addr: string) => ({ id, name: addr, initial: addr[0].toUpperCase(), path: id, addr, kind: "agent" as const });

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

type Will = { show: boolean; height: number; duration: number; curve?: number };
const will = (w: Will) =>
  act(() => {
    (window as unknown as { __k2KeyboardWill: (d: Will) => void }).__k2KeyboardWill(w);
  });

beforeEach(() => {
  vi.useFakeTimers();
  __resetViewportForTests();
  useMultiServerPrefs.setState({ multiServer: false });
  localStorage.clear();
  useHomesStore.getState().reload();
  useRecentFirstStore.getState().reload();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useZenStore.setState({
    agentSource: "stub",
    agents: [agent("/a", "alpha"), agent("/b", "bravo")],
    screen: "list",
    agentId: "",
    pinnedIds: [],
    serverProjects: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    lastAtByKey: {},
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Renders while the keyboard shows (Will…) and then settles. */
function keyboardRoundTrip(): { moving: number; settled: number } {
  renders.list = 0;
  will({ show: true, height: 300, duration: 250, curve: 7 });
  const moving = renders.list;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  return { moving, settled: renders.list - moving };
}

describe("Chats list behind an open chat", () => {
  it("on screen: follows the keyboard's motion", () => {
    mount();
    const r = keyboardRoundTrip();
    expect(r.moving).toBeGreaterThan(0);
  });

  it("hidden (a chat open): no re-render while the keyboard moves; at most one once it settles", () => {
    useZenStore.setState({ screen: "thread" });
    mount();
    const r = keyboardRoundTrip();
    expect(r.moving).toBe(0);
    expect(r.settled).toBeLessThanOrEqual(1);
  });
});
