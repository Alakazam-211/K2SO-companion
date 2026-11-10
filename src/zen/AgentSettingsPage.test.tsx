// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const scoped = vi.fn();
vi.mock("../api/scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scoped(...a) }));
vi.mock("../lib/useSessionIdentity", () => ({ useSessionIdentity: () => ({ role: "owner" }) }));

import { AgentSettingsPage } from "./AgentSettingsPage";

const scope = { id: "s1" } as never;
afterEach(cleanup);

describe("AgentSettingsPage", () => {
  it("shows that workspace's settings and permissions", async () => {
    scoped.mockResolvedValue({ ok: true, text: JSON.stringify([{ id: "p1", handle: "sew", allowRemoteInstruct: 1 }]) });
    const onBack = vi.fn();
    render(<AgentSettingsPage scope={scope} projectId="p1" name="Sew" onBack={onBack} />);
    const settings = await screen.findByTestId("agent-settings-group");
    expect(within(settings).getByText("sew")).toBeTruthy();
    expect(within(screen.getByTestId("agent-permissions-group")).getByText("On")).toBeTruthy();
    expect(screen.getByTestId("agent-settings-title").textContent).toBe("Sew");
    expect(scoped.mock.calls[0][1]).toBe("/cli/projects/list");
    fireEvent.click(screen.getByTestId("agent-settings-back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("says so when the row can't be read", async () => {
    scoped.mockResolvedValue({ ok: false, text: "" });
    render(<AgentSettingsPage scope={scope} projectId="p1" name="Sew" onBack={() => {}} />);
    expect(await screen.findByTestId("agent-settings-failed")).toBeTruthy();
  });
});
