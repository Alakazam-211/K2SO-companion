import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { answerThread } from "./client";
import { useServersStore } from "../stores/servers";

describe("answerThread", () => {
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

  it("POSTs /cli/thread/answer with addr, id, and answer as the option text", async () => {
    tauriFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });
    const r = await answerThread("appa", "card-1", "Approve");
    expect(r.ok).toBe(true);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = tauriFetch.mock.calls[0] as [
      string,
      { method?: string; body?: string },
    ];
    expect(url).toBe("http://127.0.0.1:9/cli/thread/answer");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body || "{}")).toEqual({
      addr: "appa",
      id: "card-1",
      answer: "Approve",
    });
    expect(opts.body).not.toMatch(/"value"/);
  });
});
