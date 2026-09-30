// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  inspectProjectsSummary: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getToken: vi.fn(() => ""),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
}));

vi.mock("../lib/revive", () => ({
  connectServer: vi.fn(async () => "still-valid"),
}));

import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { ChatsList } from "./ChatsList";
import { JOIN_NO_PROJECT } from "./agentRow";
import { STUB_AGENTS } from "./stubData";
import { OWNER_LIST_HOLD, useZenStore } from "./zenStore";

const SEEDED_SERVER = {
  id: "s1",
  nickname: "test",
  url: "https://example.k2.dev",
  username: "u",
  rememberPassword: false,
};

afterEach(() => cleanup());

beforeEach(() => {
  seedServer();
});

function seedServer() {
  useServersStore.setState({
    servers: [SEEDED_SERVER],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
}

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

describe("ChatsList", () => {
  it("zero stored servers is the overlay Add server form, not /login or stub chats", () => {
    useServersStore.setState({
      servers: [],
      activeServerId: null,
      hydrated: true,
    });
    mount();
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.getByText("Add server")).not.toBeNull();
    expect(screen.queryByTestId("chats-home")).toBeNull();
  });

  it("zero-server then a stored server then zero again does not throw (same hook order)", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentError: null,
      screen: "list",
    });
    useServersStore.setState({
      servers: [],
      activeServerId: null,
      hydrated: true,
    });
    mount();
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    act(() => {
      seedServer();
    });
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    act(() => {
      useServersStore.setState({
        servers: [],
        activeServerId: null,
      });
    });
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.queryByTestId("chats-home")).toBeNull();
  });

  it("is the overlay home: Chats title, pin slot, search, stub rows", () => {
    seedServer();
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    expect(screen.getByText("Chats")).not.toBeNull();
    expect(screen.getByTestId("chats-pins").textContent).toMatch(/Drop here/);
    expect(screen.getByPlaceholderText("Search")).not.toBeNull();
    expect(screen.getByLabelText(/STUB \[STUB\] not-a-real-agent-1/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "New message" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Tickets" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Server / })).not.toBeNull();
    expect(screen.queryByTestId("tickets-badge")).toBeNull();
  });

  it("the ticket icon shows the waiting count and opens the existing ticket tray", () => {
    seedServer();
    useFeedbackStore.setState({ waitingCount: 3, rows: [], isLoading: false, error: null });
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("tickets-badge").textContent).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: /Tickets, 3 waiting/ }));
    expect(screen.getByTestId("overlay-tickets")).not.toBeNull();
    expect(screen.getByText("No tickets yet.")).not.toBeNull();
  });

  it("opening a row switches the store to the thread screen", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentId: "",
    });
    mount();
    fireEvent.click(screen.getByLabelText(/STUB \[STUB\] not-a-real-agent-2/));
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useZenStore.getState().agentId).toBe(STUB_AGENTS[1].id);
  });

  it("Settings → Current app is the toggle to the original UI", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("overlay-settings").textContent).toMatch(
      /Leave this overlay and use the app as it is today/
    );
    expect(screen.getByRole("button", { name: /Current app/ })).not.toBeNull();
  });

  it("signed-in unconfirmed list is honest and empty, not stub", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentError: OWNER_LIST_HOLD,
      screen: "list",
    });
    mount();
    const empty = screen.getByTestId("chats-empty").textContent ?? "";
    expect(empty).toMatch(/No agents on this list/);
    expect(empty).toMatch(/does not invent a mapping/);
    expect(empty).toMatch(/skills enumerator/);
    expect(screen.queryByText("[STUB] not-a-real-agent-1")).toBeNull();
  });

  it("live rows without addr say so and do not claim a conversation", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: null,
          joinMiss: JOIN_NO_PROJECT,
        },
        {
          id: "/ws2",
          name: "Skin Test A",
          initial: "ST",
          path: "/ws2",
          addr: null,
          joinMiss: JOIN_NO_PROJECT,
        },
      ],
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.getByLabelText("Skin Test A")).not.toBeNull();
    expect(screen.getAllByText(JOIN_NO_PROJECT).length).toBe(2);
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.getAllByTestId("row-when").length).toBe(2);
  });

  it("a joined live row describes what it is, with time and a chevron", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/Users/Baden/Appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: { "t:appa": Date.now() / 1000 },
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("main chat");
    expect(screen.getByTestId("row-when").textContent).toMatch(/›/);
    expect(screen.getByTestId("row-when").textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("an empty last-message time is an empty slot next to the chevron", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByTestId("row-when").textContent?.replace(/\s/g, "")).toBe("›");
  });

  it("a sidecar row keeps the name on line one and the chat title on line two", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "k2so-companion / 1",
          initial: "K",
          path: "/ws",
          addr: "k2so-companion/1",
          joinMiss: null,
          kind: "agent",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("k2so-companion / 1")).not.toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("k2so-companion / 1");
  });

  it("the plus button opens the New Message picker", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(screen.getByTestId("overlay-compose")).not.toBeNull();
    expect(screen.getByText("New Message")).not.toBeNull();
  });

  it("Settings has no DEBUG projects-summary", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentError: OWNER_LIST_HOLD,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText(/DEBUG/)).toBeNull();
    expect(screen.queryByTestId("summary-dump")).toBeNull();
  });

  it("a project chat row says Project Chat", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "group:pg1",
          name: "K2 Companion",
          initial: "K",
          kind: "group",
          groupId: "pg1",
          memberCount: 3,
          addr: null,
          joinMiss: null,
        },
      ],
      lastAtByKey: {},
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("K2 Companion")).not.toBeNull();
    expect(screen.getByTestId("row-preview").textContent).toBe("Project Chat");
  });

  it("the server button opens the overlay server list", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Server / }));
    expect(screen.getByTestId("overlay-servers")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Servers" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "test" })).not.toBeNull();
  });
});
