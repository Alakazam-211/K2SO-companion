// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  inspectProjectsSummary: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getToken: vi.fn(() => ""),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
}));

import { inspectProjectsSummary } from "../api/client";
import { ChatsList } from "./ChatsList";
import { JOIN_NO_PROJECT } from "./agentRow";
import { STUB_AGENTS } from "./stubData";
import { OWNER_LIST_HOLD, useZenStore } from "./zenStore";

afterEach(() => cleanup());

function mount() {
  return render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
}

describe("ChatsList", () => {
  it("is the overlay home: Chats title, pin slot, search, stub rows", () => {
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
    expect((screen.getByRole("button", { name: "New message" }) as HTMLButtonElement).disabled).toBe(true);
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
  });

  it("a joined live row is labelled Thread", () => {
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
        },
      ],
      agentError: null,
      screen: "list",
    });
    mount();
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.getByText("Thread")).not.toBeNull();
  });

  it("DEBUG dump is behind a tap and never shown on load", async () => {
    vi.mocked(inspectProjectsSummary).mockResolvedValue({
      status: 200,
      data: [{ name: "appa", path: "/Users/Baden/Appa", token: "SESSION-SECRET" }],
      note: null,
    });
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentError: OWNER_LIST_HOLD,
      screen: "list",
    });
    mount();
    expect(screen.queryByTestId("summary-dump")).toBeNull();
    expect(inspectProjectsSummary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByTestId("summary-dump")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /DEBUG projects-summary/ }));
    const dump = await screen.findByTestId("summary-dump");
    expect(dump.textContent).toMatch(/HTTP status: 200/);
    expect(dump.textContent).toMatch(/Row count: 1/);
    expect(dump.textContent).toMatch(/appa · \/Users\/Baden\/Appa/);
    expect(dump.textContent).not.toMatch(/SESSION-SECRET/);
  });
});
