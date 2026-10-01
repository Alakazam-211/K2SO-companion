import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { setSessionLabel } from "./client";
import { useServersStore } from "../stores/servers";

describe("setSessionLabel", () => {
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

  it("GETs /cli/sessions/label with id and label on the query string", async () => {
    tauriFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({ success: true, label: "qa731", locked: true }),
    });
    const r = await setSessionLabel(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "qa731"
    );
    expect(r).toEqual({
      ok: true,
      data: { success: true, label: "qa731", locked: true },
    });
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = tauriFetch.mock.calls[0] as [
      string,
      { method?: string; body?: string },
    ];
    expect(url).toBe(
      "http://127.0.0.1:9/cli/sessions/label?id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&label=qa731"
    );
    expect(opts.method).toBe("GET");
    expect(opts.body).toBeUndefined();
  });
});
