// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentRail } from "./AgentRail";
import { STUB_AGENTS } from "./stubData";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

describe("AgentRail stub markers", () => {
  it("puts a STUB mark on every stub agent row", () => {
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      agentId: STUB_AGENTS[0].id,
      agentError: null,
    });
    render(<AgentRail />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(STUB_AGENTS.length);
    expect(screen.getByLabelText(/STUB \[STUB\] not-a-real-agent-1/)).not.toBeNull();
  });

  it("live agents have no per-row STUB mark", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [{ id: "alpha", name: "alpha", initial: "A", path: "/ws", addr: "alpha" }],
      agentId: "alpha",
      agentError: null,
    });
    render(<AgentRail />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
    expect(screen.getByLabelText("alpha")).not.toBeNull();
    expect(screen.queryByText("no chat")).toBeNull();
  });

  it("live rows without an overlay addr are marked no chat and still shown", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [{ id: "appa", name: "appa", initial: "A", path: "/ws", addr: null }],
      agentId: "appa",
      agentError: null,
    });
    render(<AgentRail />);
    expect(screen.getByLabelText("appa")).not.toBeNull();
    expect(screen.getByText("no chat")).not.toBeNull();
  });

  it("live empty rail says no agents are shared yet", () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [],
      agentId: "",
      agentError: "No agents on this list.",
    });
    render(<AgentRail />);
    const empty = screen.getByTestId("agent-rail-empty");
    expect(empty.textContent).toMatch(/No chats/);
    expect(empty.textContent).toMatch(/No agents on this list/);
  });

  it("loading empty rail does not claim No chats", () => {
    useZenStore.setState({
      agentSource: "loading",
      agents: [],
      agentId: "",
      agentError: null,
    });
    render(<AgentRail />);
    expect(screen.queryByTestId("agent-rail-empty")).toBeNull();
  });

  it("error empty rail shows the error string", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentId: "",
      agentError: "skin.agents failed",
    });
    render(<AgentRail />);
    expect(screen.getByTestId("agent-rail-empty").textContent).toMatch(
      /skin\.agents failed/
    );
    expect(screen.queryByText(/No agents on this list/)).toBeNull();
  });

  it("signed-in hold says why the list is empty", () => {
    useZenStore.setState({
      agentSource: "error",
      agents: [],
      agentId: "",
      agentError:
        "No agents on this list. A fleet-sized owner list is not confirmed yet. /cli/skin/agents is grant-scoped. /cli/agents/list is the skills enumerator. This overlay does not invent a mapping.",
    });
    render(<AgentRail />);
    const empty = screen.getByTestId("agent-rail-empty").textContent ?? "";
    expect(empty).toMatch(/does not invent a mapping/);
    expect(empty).toMatch(/skills enumerator/);
  });

  it("61 agents are all in the DOM inside a scroll region, with names not just initials", () => {
    const agents = Array.from({ length: 61 }, (_, i) => ({
      id: `k2-agent-${i}`,
      name: `k2-agent-${i}`,
      initial: "K",
      path: "/ws",
    }));
    useZenStore.setState({
      agentSource: "live",
      agents,
      agentId: agents[0].id,
      agentError: null,
    });
    render(<AgentRail />);
    const scroller = document.querySelector("[data-testid='agent-rail-scroll']");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toMatch(/overflow-y-auto/);
    expect(screen.getAllByRole("button").length).toBe(61);
    expect(screen.getByText("k2-agent-40")).not.toBeNull();
    expect(screen.getByLabelText("k2-agent-40")).not.toBeNull();
  });
});
