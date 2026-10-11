import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { getActivitySnapshot, getThreadActivity, resetActivityRouteMemory } from "./client";
import { useServersStore } from "../stores/servers";

function answer(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function useServer(id: string, url: string) {
  useServersStore.setState({
    servers: [{ id, nickname: id, url, username: "u", rememberPassword: false }],
    activeServerId: id,
    tokens: { [id]: "tok" },
  });
}

describe("activity routes on a pre-0.45 server", () => {
  beforeEach(() => {
    tauriFetch.mockReset();
    resetActivityRouteMemory();
    useServer("old", "http://127.0.0.1:9");
  });

  afterEach(() => {
    useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
  });

  it("stops asking a server that 404'd the snapshot route, for both routes", async () => {
    tauriFetch.mockResolvedValue(answer(404, { error: "route not found" }));
    const first = await getActivitySnapshot();
    expect(first).toMatchObject({ ok: false, status: 404 });
    expect(await getActivitySnapshot()).toMatchObject({ ok: false, status: 404 });
    expect(await getThreadActivity("appa")).toMatchObject({ ok: false, status: 404 });
    expect(tauriFetch).toHaveBeenCalledTimes(1);

    // Another server is asked afresh.
    useServer("new", "http://127.0.0.1:10");
    tauriFetch.mockResolvedValue(answer(200, { rows: [], workspaces: [] }));
    expect((await getActivitySnapshot()).ok).toBe(true);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("remembers a route-level 404 on /cli/thread/activity", async () => {
    tauriFetch.mockResolvedValue(answer(404, { error: "route not found" }));
    await getThreadActivity("appa");
    await getThreadActivity("appa");
    await getActivitySnapshot();
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unknown addr 404 as an old server", async () => {
    tauriFetch.mockResolvedValue(
      answer(404, { ok: false, error: { code: "not_found", hint: "unknown overlay addr 'x/9'" } })
    );
    await getThreadActivity("x/9");
    await getThreadActivity("x/9");
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps asking after a transient failure", async () => {
    tauriFetch.mockResolvedValue(answer(502, { error: "bad gateway" }));
    await getActivitySnapshot();
    await getActivitySnapshot();
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });
});
