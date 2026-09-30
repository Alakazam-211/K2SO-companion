// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => ""),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  inspectProjectsSummary: vi.fn(),
}));

import { STUB_AGENTS } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

afterEach(() => cleanup());

describe("Zen keeps the chats list mounted", () => {
  it("chats-home stays in the document after opening a thread", async () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(useZenStore.getState().agentSource).toBe("stub")
    );
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    expect(useZenStore.getState().screen).toBe("thread");
    expect(screen.getByTestId("chats-home")).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("chats-layer").getAttribute("aria-hidden")).toBe(
        "true"
      )
    );
  });
});
