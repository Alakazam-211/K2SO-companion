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
      agents: [{ id: "alpha", name: "alpha", initial: "A", path: "/ws" }],
      agentId: "alpha",
      agentError: null,
    });
    render(<AgentRail />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
    expect(screen.getByLabelText("alpha")).not.toBeNull();
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
