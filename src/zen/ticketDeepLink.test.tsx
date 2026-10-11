// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

// Same api surface ChatsList.test stubs; nothing here talks to a daemon.
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
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../lib/revive", () => ({ connectServer: vi.fn(async () => "still-valid") }));

// The real overlay is covered by TicketsOverlay.test; here only the hand-off.
vi.mock("./TicketsOverlay", () => ({
  useTicketWaitingCounts: () => ({ me: [], counts: { waiting: 0, mine: 0, all: 0 }, ready: true }),
  TicketsOverlay: ({ initialTicketId }: { initialTicketId?: string | null }) => (
    <div data-testid="tickets-overlay-stub">{initialTicketId ?? ""}</div>
  ),
}));

import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { STUB_AGENTS } from "./stubData";
import { zenTicketPath } from "./terminalJump";
import { useZenStore } from "./zenStore";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mountAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatsList />
      <Where />
    </MemoryRouter>
  );
}

beforeEach(() => {
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useZenStore.setState({ agentSource: "stub", agents: STUB_AGENTS, screen: "list", agentId: "" });
});

afterEach(() => cleanup());

describe("zenTicketPath", () => {
  it("builds /zen?ticket=<id>, encoded; empty is plain /zen", () => {
    expect(zenTicketPath("fb-1")).toBe("/zen?ticket=fb-1");
    expect(zenTicketPath("a/b c")).toBe("/zen?ticket=a%2Fb%20c");
    expect(zenTicketPath("  ")).toBe("/zen");
  });
});

describe("?ticket= deep link", () => {
  it("opens the Tickets overlay on that ticket and strips the param", async () => {
    mountAt("/zen?ticket=fb-42");
    await waitFor(() => screen.getByTestId("tickets-overlay-stub"));
    expect(screen.getByTestId("tickets-overlay-stub").textContent).toBe("fb-42");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/zen"));
  });

  it("closes an open chat so the overlay is visible", async () => {
    useZenStore.setState({ screen: "thread", agentId: "/a" });
    mountAt("/zen?ticket=fb-7");
    await waitFor(() => screen.getByTestId("tickets-overlay-stub"));
    expect(useZenStore.getState().screen).toBe("list");
  });

  it("no param leaves Tickets closed", () => {
    mountAt("/zen");
    expect(screen.queryByTestId("tickets-overlay-stub")).toBeNull();
  });
});
