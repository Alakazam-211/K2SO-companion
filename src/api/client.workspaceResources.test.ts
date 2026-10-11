import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { getWorkspaceResources } from "./client";
import { useServersStore } from "../stores/servers";

const WS = "/Users/z3thon/DevProjects/Alakazam Labs/K2SO-companion";

describe("getWorkspaceResources", () => {
  beforeEach(() => {
    tauriFetch.mockReset();
    useServersStore.setState({
      servers: [
        {
          id: "s1",
          nickname: "t",
          url: "http://127.0.0.1:9",
          username: "u",
          rememberPassword: false,
        },
      ],
      activeServerId: "s1",
      tokens: { s1: "tok" },
    });
  });

  afterEach(() => {
    useServersStore.setState({
      servers: [],
      activeServerId: null,
      tokens: {},
    });
  });

  it("GETs /cli/workspace/resources with the encoded workspace path", async () => {
    const body = {
      ok: true,
      workspaceId: "w1",
      docs: [
        {
          filePath: `${WS}/docs/ios-keyboard-layout.md`,
          fileName: "ios-keyboard-layout.md",
          addedAt: 1791702163,
          missing: false,
        },
      ],
    };
    tauriFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(body),
    });
    const r = await getWorkspaceResources(WS);
    expect(r).toEqual({ ok: true, data: body });
    const [url, opts] = tauriFetch.mock.calls[0] as [string, { method?: string }];
    expect(url).toBe(
      "http://127.0.0.1:9/cli/workspace/resources?workspace=%2FUsers%2Fz3thon%2FDevProjects%2FAlakazam%20Labs%2FK2SO-companion"
    );
    expect(opts.method).toBe("GET");
  });

  it("an older server's 404 comes back as status 404, not a throw", async () => {
    tauriFetch.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ error: "route not found" }),
    });
    const r = await getWorkspaceResources(WS);
    expect(r).toEqual({ ok: false, error: "route not found", status: 404 });
  });
});
