// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Agents > chat > Sessions drawer > Active session > Terminal > Done must
// land back on THAT session's thread, in Done mode, with the drawer origin.

vi.mock("../components/TerminalView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TerminalView")>();
  return {
    ...actual,
    TerminalView: (p: { terminalId: string }) => (
      <div data-testid="terminal-view" data-terminal={p.terminalId} />
    ),
  };
});

vi.mock("../api/sendMessage", () => ({
  sendMessageToSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(async () => ({ ok: true, data: { resources: [] } })),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  getActivitySnapshot: vi.fn(async () => ({ ok: true, data: { rows: [], workspaces: [] } })),
  getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(),
  spawnSidecarSession: vi.fn(),
  spawnTabSession: vi.fn(),
  spawnResumeTab: vi.fn(),
  getActivePresets: vi.fn(async () => ({ ok: true, data: [] })),
  uploadFsBinary: vi.fn(),
  ensurePinnedChat: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
  getWorkspaceLiveSessions: vi.fn(),
  getChatList: vi.fn(async () => ({ ok: true, data: [] })),
  getChatCustomNames: vi.fn(async () => ({ ok: true, data: {} })),
  getThreadLatest: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  getAppSettings: vi.fn(async () => ({ ok: true, data: { focusGroupsEnabled: false } })),
  getFocusGroupsList: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import {
  getAgentList,
  getAllSessions,
  getCliProjectsList,
  getThread,
  getWorkspaceLiveSessions,
  spawnSidecarSession,
} from "../api/client";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { DRAWER_ORIGIN_KEY } from "../zen/sessionDrawer";
import { zenTerminalPath } from "../zen/terminalJump";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";
import { ZenTerminal } from "./ZenTerminal";

const CONVO = "0a0b0c0d-0000-4000-8000-0000000000c1";
const base = { workspaceName: "K2", workspaceId: "k2", workspaceColor: "#000" };
/** GET /cli/companion/sessions */
const SESSIONS = [
  { ...base, cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true, command: "claude" },
  { ...base, cwd: "/ws", agentName: "reviewer", terminalId: "t-rev", label: "Code review", command: "claude" },
  // A desktop `+` tab whose Thread is `k2/3` (not keyed by its agentName).
  { ...base, cwd: "/ws", agentName: "tab-77", terminalId: "t-77", label: "Scratch", command: "claude" },
  // A plain tab whose Thread is its bare conversation id.
  { ...base, cwd: "/ws", agentName: "tab-88", terminalId: "t-88", label: "Convo", command: "claude" },
];
/** GET /cli/sessions/list-for-workspace?path=/ws */
const LIVE = [
  { sessionId: "t-main", agentName: "k2", kind: "canonical", handle: "k2", conversationId: "c-main", command: "claude" },
  { sessionId: "t-rev", agentName: "reviewer", kind: "other", handle: "", conversationId: "c-rev", command: "claude" },
  { sessionId: "t-77", agentName: "tab-77", kind: "sidecar", handle: "k2/3", conversationId: "c-77", command: "claude" },
  { sessionId: "t-88", agentName: "tab-88", kind: "other", handle: "", conversationId: CONVO, command: "claude" },
];

/** Addrs whose Thread the daemon no longer knows. */
let staleAddrs = new Set<string>();

function Loc() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function routes(entry: string | { pathname: string; state?: unknown }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/zen" element={<Zen />} />
        <Route path="/zen/terminal/:terminalId" element={<ZenTerminal />} />
        <Route path="*" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
}

async function openMain() {
  render(routes("/zen?thread=%2Fws"));
  await waitFor(() => expect(useZenStore.getState().agentSource).toBe("live"));
  await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
  expect(useZenStore.getState().agentId).toBe("/ws");
}

async function pick(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
  const drawer = await screen.findByTestId("sessions-drawer");
  const row = await within(drawer).findByText(label);
  fireEvent.click(row.closest("button")!);
}

async function toTerminal(terminalId: string) {
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  await waitFor(() =>
    expect(screen.getByTestId("terminal-view").getAttribute("data-terminal")).toBe(terminalId)
  );
}

async function expectSessionThread(addr: string, header?: string) {
  await waitFor(() => expect(useZenStore.getState().threadAddr).toBe(addr));
  await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
  const s = useZenStore.getState();
  expect(s.screen).toBe("thread");
  expect(s.agents.find((a) => a.id === s.agentId)?.addr).toBe(addr);
  expect(s.threadError).toBeNull();
  expect(s.drawerOrigin).toBe("/ws");
  expect(sessionStorage.getItem(DRAWER_ORIGIN_KEY)).toBe("/ws");
  expect(screen.queryByTestId("zen-terminal")).toBeNull();
  expect(screen.getByTestId("chat-done").textContent).toBe("Done");
  // The same header the drawer pick showed.
  if (header !== undefined) {
    expect(screen.getByTestId("chat-header-title").textContent).toBe(header);
  }
  expect(screen.queryByText("Not chattable")).toBeNull();
}

beforeEach(() => {
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
  staleAddrs = new Set();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useWorkspacesStore.setState({ allSessions: [], projects: [] });
  useZenStore.setState({ agents: [], agentId: "", screen: "list", drawerOrigin: null });
  vi.mocked(getAgentList).mockResolvedValue({
    ok: true,
    data: { ok: true, agents: [{ name: "k2", path: "/ws" }] },
  } as never);
  vi.mocked(getCliProjectsList).mockResolvedValue({
    ok: true,
    data: [{ id: "pk", name: "K2", handle: "k2", path: "/ws", pinned: 0, tabOrder: 0, focusGroupId: null }],
  } as never);
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: SESSIONS } as never);
  vi.mocked(getWorkspaceLiveSessions).mockResolvedValue({ ok: true, data: LIVE } as never);
  vi.mocked(getThread).mockImplementation(async (_scope, addr: string) =>
    staleAddrs.has(addr)
      ? ({
          ok: false,
          status: 404,
          error: `{"error":{"code":"not_found","hint":"unknown overlay addr '${addr}'"}}`,
        } as never)
      : ({
          ok: true,
          data: { items: [{ seq: 1, from: addr, text: `hello from ${addr}`, at: 1 }] },
        } as never)
  );
  vi.mocked(spawnSidecarSession).mockReset();
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  sessionStorage.clear();
  localStorage.clear();
});

describe("Terminal Done from a drawer-picked session", () => {
  it.each([
    ["sidecar agent/x", "Code review", "k2/reviewer", "t-rev", "k2/reviewer"],
    ["ws/N tab", "Scratch", "k2/3", "t-77", "k2/3"],
    ["conversation-id tab", "Convo", CONVO, "t-88", "k2/Convo"],
  ])("%s: Terminal → Done reopens that thread in Done mode", async (_kind, label, addr, tid, title) => {
    await openMain();
    await pick(label);
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe(addr));
    expect(useZenStore.getState().drawerOrigin).toBe("/ws");
    const header = screen.getByTestId("chat-header-title").textContent ?? "";
    expect(header).toBe(title);
    await toTerminal(tid);

    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    await expectSessionThread(addr, header);
    // Back on the session's own thread, not the main chat's.
    const calls = vi.mocked(getThread).mock.calls;
    expect(calls[calls.length - 1]?.[1]).toBe(addr);

    // The chat's own Done then returns to the main chat.
    fireEvent.click(screen.getByTestId("chat-done"));
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
    expect(useZenStore.getState().agentId).toBe("/ws");
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(screen.getByTestId("chat-back")).not.toBeNull();
    expect(screen.queryByTestId("chat-done")).toBeNull();
  });

  it("a reload on the terminal page, then Done, still lands on the session thread", async () => {
    await openMain();
    await pick("Scratch");
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/3"));
    await toTerminal("t-77");

    // Reload: router state and the in-memory store are gone; sessionStorage is not.
    cleanup();
    act(() => {
      useZenStore.setState({
        agents: [],
        agentId: "",
        screen: "list",
        drawerOrigin: null,
        threadAddr: null,
        thread: [],
      });
    });
    render(routes(zenTerminalPath("t-77")));
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    await expectSessionThread("k2/3", "k2/3");

    fireEvent.click(screen.getByTestId("chat-done"));
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
    expect(useZenStore.getState().agentId).toBe("/ws");
  });

  it("a session whose thread is gone shows a friendly fallback with Open main chat", async () => {
    await openMain();
    await pick("Convo");
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe(CONVO));
    await toTerminal("t-88");

    // While on the terminal, the conversation ended and K2 forgot its Thread.
    staleAddrs.add(CONVO);
    vi.mocked(getThread).mockClear();
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    await waitFor(() => expect(getThread).toHaveBeenCalledWith(expect.anything(), CONVO));
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("error"));
    const box = screen.getByTestId("thread-unavailable");
    expect(box.textContent).toMatch(/can't open this session's thread/i);
    expect(box.textContent).not.toMatch(/not_found|\{/);
    expect(useZenStore.getState().drawerOrigin).toBe("/ws");

    fireEvent.click(within(box).getByRole("button", { name: "Open main chat" }));
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
    expect(useZenStore.getState().agentId).toBe("/ws");
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(screen.queryByTestId("thread-unavailable")).toBeNull();
  });

  it("an addr with no row and no return context shows the friendly fallback, not a raw error", async () => {
    await openMain();
    await pick("Code review");
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/reviewer"));
    // A stale return to an addr K2 no longer lists, with no session context.
    cleanup();
    render(routes("/zen?addr=k2%2Fgone"));
    const box = await screen.findByTestId("thread-unavailable");
    expect(box.textContent).toMatch(/can't open this session's thread/i);
    fireEvent.click(within(box).getByRole("button", { name: "Open main chat" }));
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
    expect(useZenStore.getState().agentId).toBe("/ws");
  });
});
