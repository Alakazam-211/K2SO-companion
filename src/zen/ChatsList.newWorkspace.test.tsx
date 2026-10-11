// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const who = vi.hoisted(() => ({
  identity: { username: "u", owner: false, role: "member" } as {
    username: string;
    owner: boolean;
    role?: string | null;
  } | null,
}));
vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => who.identity,
}));

import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { STUB_AGENTS } from "./stubData";
import { FOCUS_OFF } from "./serverPins";
import { useZenStore } from "./zenStore";

beforeEach(() => {
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useZenStore.setState({
    agentSource: "stub",
    agents: STUB_AGENTS,
    screen: "list",
    pinnedIds: [],
    serverProjects: [],
    focus: FOCUS_OFF,
  });
});

afterEach(() => cleanup());

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

describe("Agents + (New workspace)", () => {
  it("a Member opens the New Workspace sheet", () => {
    who.identity = { username: "u", owner: false, role: "member" };
    mount();
    const plus = screen.getByRole("button", { name: "New workspace" });
    expect(plus.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(plus);
    expect(screen.getByTestId("new-workspace")).not.toBeNull();
  });

  it("a role below Member gets a dimmed + and a note, not the sheet", () => {
    who.identity = { username: "u", owner: false, role: "viewer" };
    mount();
    const plus = screen.getByRole("button", { name: "New workspace" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    expect(plus.style.opacity).toBe("0.4");
    fireEvent.click(plus);
    expect(screen.queryByTestId("new-workspace")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Your account can’t create workspaces on this server"
    );
  });

  it("the Servers sheet + still opens Add server", () => {
    who.identity = { username: "u", owner: true, role: "owner" };
    mount();
    fireEvent.click(screen.getByTestId("chats-header-server"));
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.queryByTestId("new-workspace")).toBeNull();
  });
});
