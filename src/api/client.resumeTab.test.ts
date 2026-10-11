import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { spawnResumeTab } from "./client";
import { scopeFor } from "./scope";
import { useServersStore } from "../stores/servers";

describe("spawnResumeTab", () => {
  beforeEach(() => {
    tauriFetch.mockReset();
    useServersStore.setState({
      servers: [{ id: "s1", nickname: "t", url: "http://127.0.0.1:9", username: "u", rememberPassword: false }],
      activeServerId: "s1",
      tokens: { s1: "tok" },
    });
  });

  it("POSTs /cli/sessions/v2/spawn as a new locked tab carrying the resume argv", async () => {
    tauriFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ sessionId: "t-1", agentName: "tab-x", conversationId: "c-1" }),
    });
    const r = await spawnResumeTab(scopeFor("s1"), "/ws", { command: "codex", args: ["--yolo", "resume", "c-1"] }, "Refactor");
    expect(r.ok).toBe(true);
    const [url, opts] = tauriFetch.mock.calls[0] as [string, { method?: string; body?: string }];
    expect(url).toBe("http://127.0.0.1:9/cli/sessions/v2/spawn");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body || "");
    expect(body).toMatchObject({
      cwd: "/ws",
      command: "codex",
      args: ["--yolo", "resume", "c-1"],
      label: "Refactor",
      label_locked: true,
    });
    expect(body.agent_name).toMatch(/^tab-/);
  });
});
