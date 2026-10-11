// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Agents header > Projects: the project chats sheet, a project chat in
// the Zen thread view (Back → the sheet, Done → Agents), its header (the
// project's image, Files only) and its Files, and a project push tap
// landing through the sheet.

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
  fetchProjectGroups: vi.fn(),
  fetchProjectGroupMessages: vi.fn(),
  postProjectGroupMessage: vi.fn(),
  fetchProjectGroupShow: vi.fn(),
  fetchProjectGroupResources: vi.fn(),
  fetchProjectGroupIcon: vi.fn(async () => ({ ok: true, data: { found: false, dataUrl: null } })),
  fetchUnreadGroupIds: vi.fn(async () => []),
}));

import { getAgentList, getAllSessions, getCliProjectsList, getThread } from "../api/client";
import {
  fetchProjectGroupIcon,
  fetchProjectGroupMessages,
  fetchProjectGroupResources,
  fetchProjectGroupShow,
  fetchProjectGroups,
} from "../api/projectGroups";
import { useProjectGroupsStore } from "../stores/projectGroups";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { resetLastAtQueue } from "../zen/lastAtFetch";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";
import { ZenTerminal } from "./ZenTerminal";

const GROUPS = [
  { id: "pg1", name: "Alpha", pocWorkspaceId: "pk", pinned: false, color: "#ff375f", sortOrder: 0, createdAt: 1, updatedAt: 1, memberCount: 2 },
  { id: "pg2", name: "Bravo", pocWorkspaceId: "pk", pinned: false, color: null, sortOrder: 1, createdAt: 1, updatedAt: 1, memberCount: 3 },
  { id: "pg3", name: "Charlie", pocWorkspaceId: null, pinned: false, color: null, sortOrder: 2, createdAt: 1, updatedAt: 1, memberCount: 0 },
];
const NOW = Math.floor(Date.now() / 1000);
const MESSAGES: Record<string, { id: string; groupId: string; author: string; body: string; createdAt: number }[]> = {
  pg1: [{ id: "m1", groupId: "pg1", author: "k2", body: "alpha news", createdAt: NOW - 600 }],
  pg2: [
    { id: "m2", groupId: "pg2", author: "u", body: "first", createdAt: NOW - 120 },
    { id: "m3", groupId: "pg2", author: "k2", body: "hi\n bravo", createdAt: NOW - 60 },
  ],
  pg3: [],
};
const SESSIONS = [
  { workspaceName: "K2", workspaceId: "pk", workspaceColor: "#000", cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true, command: "claude" },
];

let groups = GROUPS;

function Loc() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function routes(entry: string) {
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

async function openAgents() {
  render(routes("/zen"));
  await waitFor(() => expect(useZenStore.getState().agentSource).toBe("live"));
}

async function openSheet() {
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  const sheet = await screen.findByTestId("overlay-projects");
  await waitFor(() => expect(within(sheet).getAllByTestId("project-row")).toHaveLength(groups.length));
  return sheet;
}

async function openGroup(name: string) {
  const sheet = await openSheet();
  fireEvent.click(within(sheet).getByText(name).closest("button")!);
  await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
}

beforeEach(() => {
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
  groups = GROUPS;
  resetLastAtQueue();
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
  useProjectGroupsStore.setState({ icons: {} });
  vi.mocked(fetchProjectGroupIcon).mockImplementation(async () => ({
    ok: true,
    data: { found: false, dataUrl: null },
  }));
  useZenStore.setState({
    agents: [],
    agentId: "",
    screen: "list",
    drawerOrigin: null,
    projectsOpen: false,
    lastAtByKey: {},
    groupPreviews: {},
  });
  vi.mocked(getAgentList).mockResolvedValue({
    ok: true,
    data: { ok: true, agents: [{ name: "k2", path: "/ws" }] },
  } as never);
  vi.mocked(getCliProjectsList).mockResolvedValue({
    ok: true,
    data: [{ id: "pk", name: "K2", handle: "k2", path: "/ws", pinned: 0, tabOrder: 0, focusGroupId: null, color: "#30d158" }],
  } as never);
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: SESSIONS } as never);
  vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } } as never);
  vi.mocked(fetchProjectGroups).mockImplementation(async () => ({ ok: true, data: groups }));
  vi.mocked(fetchProjectGroupMessages).mockImplementation(async (_scope, group, opts) => {
    const all = MESSAGES[group] ?? [];
    const limit = opts?.limit ?? 20;
    return { ok: true, data: { messages: all.slice(-limit), truncated: false } };
  });
  vi.mocked(fetchProjectGroupShow).mockResolvedValue({
    ok: true,
    data: {
      ...GROUPS[1],
      members: [{ workspaceId: "pk", name: "K2", path: "/ws", agentName: "k2", createdAt: 1 }],
    },
  });
  vi.mocked(fetchProjectGroupResources).mockResolvedValue({
    ok: true,
    data: {
      docs: [{ workspaceId: "pk", workspaceName: "K2", agentName: "k2", filePath: "/ws/docs/plan.md", fileName: "plan.md" }],
    },
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useZenStore.getState().closeChat();
    useZenStore.getState().setProjectsOpen(false);
  });
  sessionStorage.clear();
  localStorage.clear();
});

describe("Zen Projects", () => {
  it("project chats are only behind the Projects button, with an unread badge", async () => {
    await openAgents();
    // The group rows are on the read (setAgent needs them) but not listed.
    expect(useZenStore.getState().agents.some((a) => a.kind === "group")).toBe(true);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Bravo")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "Bravo" } });
    expect(screen.queryByText("Bravo")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "" } });

    const right = screen.getByTestId("chats-header-right");
    const projects = screen.getByRole("button", { name: "Projects" });
    expect(right.firstElementChild).toBe(projects);
    expect(projects.nextElementSibling).toBe(screen.getByRole("button", { name: /^Tickets/ }));
    // Alpha and Bravo have messages this device never saw.
    await waitFor(() => expect(screen.getByTestId("projects-badge").textContent).toBe("2"));
  });

  it("the sheet lists groups by most recent message, with previews and search", async () => {
    await openAgents();
    const sheet = await openSheet();
    expect(within(sheet).getByRole("heading", { name: "Projects" })).not.toBeNull();
    expect(within(sheet).getByTestId("projects-done").className).toMatch(/zen-glass-pill/);
    // Charlie (no messages) keeps the daemon's order, at the bottom.
    await waitFor(() =>
      expect(within(sheet).getAllByTestId("project-row").map((r) => r.dataset.groupId)).toEqual([
        "pg2",
        "pg1",
        "pg3",
      ])
    );
    const [bravo, , charlie] = within(sheet).getAllByTestId("project-row");
    expect(bravo.className).toMatch(/k2-tile/);
    expect(within(bravo).getByTestId("project-preview").textContent).toBe("k2: hi bravo");
    expect(within(bravo).getByText("3 members")).not.toBeNull();
    expect(within(bravo).getByTestId("project-unread")).not.toBeNull();
    expect(within(charlie).getByTestId("project-preview").textContent).toBe("0 members");
    expect(within(sheet).queryByRole("button", { name: "New workspace" })).toBeNull();

    fireEvent.change(within(sheet).getByTestId("projects-search-input"), { target: { value: "alp" } });
    expect(within(sheet).getAllByTestId("project-row").map((r) => r.dataset.groupId)).toEqual(["pg1"]);
  });

  it("empty state", async () => {
    groups = [];
    await openAgents();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect((await screen.findByTestId("projects-empty")).textContent).toBe("No project chats yet");
  });

  it("a row opens the group chat; Back returns to the sheet; Done returns to Agents", async () => {
    await openAgents();
    await openGroup("Bravo");
    const s = useZenStore.getState();
    expect(s.screen).toBe("thread");
    expect(s.threadGroupId).toBe("pg2");
    expect(s.agentId).toBe("group:pg2");
    expect(screen.getByTestId("chat-header-title").textContent).toBe("Bravo");
    expect(screen.getByText("first")).not.toBeNull();
    // Project chat header: Files only, no Terminal or Sessions.
    const buttons = screen.getByTestId("chat-header-buttons");
    expect(Array.from(buttons.children).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Files",
    ]);
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
    expect(useZenStore.getState().screen).toBe("list");
    expect(screen.getByTestId("overlay-projects")).not.toBeNull();
    // Bravo was read in the chat: only Alpha is still unread.
    await waitFor(() => expect(screen.getByTestId("projects-badge").textContent).toBe("1"));

    fireEvent.click(screen.getByTestId("projects-done"));
    expect(screen.queryByTestId("overlay-projects")).toBeNull();
    expect(useZenStore.getState().projectsOpen).toBe(false);
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
  });

  it("a group opened outside the sheet goes Back to Agents", async () => {
    await openAgents();
    act(() => useZenStore.getState().setAgent("group:pg1"));
    fireEvent.click(await screen.findByRole("button", { name: "Back to chats" }));
    expect(screen.queryByTestId("overlay-projects")).toBeNull();
  });

  it("an agent chat keeps Terminal · Sessions · Files", async () => {
    await openAgents();
    const row = useZenStore.getState().agents.find((a) => a.kind !== "group");
    expect(row).toBeDefined();
    act(() => useZenStore.getState().setAgent(row!.id));
    const buttons = await screen.findByTestId("chat-header-buttons");
    expect(Array.from(buttons.children).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Terminal",
      "Sessions",
      "Files",
    ]);
  });

  it("the project chat header shows the project's image, as its sheet row does", async () => {
    vi.mocked(fetchProjectGroupIcon).mockImplementation(async (_scope, group) =>
      group === "pg1"
        ? { ok: true, data: { found: true, dataUrl: "data:image/png;base64,QUxQSEE=" } }
        : { ok: true, data: { found: false, dataUrl: null } }
    );
    await openAgents();
    const sheet = await openSheet();
    const alphaRow = within(sheet)
      .getAllByTestId("project-row")
      .find((r) => r.dataset.groupId === "pg1")!;
    await waitFor(() =>
      expect(alphaRow.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,QUxQSEE=")
    );
    fireEvent.click(within(sheet).getByText("Alpha").closest("button")!);
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    const avatar = screen.getByTestId("chat-header-avatar");
    expect(fetchProjectGroupIcon).toHaveBeenCalledWith(expect.anything(), "pg1");
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,QUxQSEE=");
    expect(within(avatar).getByTestId("workspace-avatar-glass")).not.toBeNull();
  });

  it("a project with no image falls back to its colour and initial", async () => {
    await openAgents();
    await openGroup("Alpha");
    const avatar = within(screen.getByTestId("chat-header-avatar")).getByTestId("workspace-avatar");
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
    // Alpha's own colour (#ff375f) from the project settings.
    expect(avatar.style.background).toBe("rgb(255, 55, 95)");
  });

  it("Files lists the project's resources", async () => {
    await openAgents();
    await openGroup("Bravo");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const pane = await screen.findByTestId("file-pane");
    await waitFor(() => expect(within(pane).getByText("plan.md")).not.toBeNull());
    expect(fetchProjectGroupResources).toHaveBeenCalledWith(expect.anything(), "pg2");
  });

  it("a project push tap opens the group chat through Projects", async () => {
    render(routes("/zen?project=pg1"));
    await waitFor(() => expect(useZenStore.getState().threadGroupId).toBe("pg1"));
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(useZenStore.getState().projectsOpen).toBe(true);
    expect(screen.getByTestId("chat-header-title").textContent).toBe("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
    expect(await screen.findByTestId("overlay-projects")).not.toBeNull();
    fireEvent.click(screen.getByTestId("projects-done"));
    expect(screen.getByRole("heading", { name: "Agents" })).not.toBeNull();
  });
});
