import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { resetWriteVerbMemory, setSessionLabel, writeVerbFor } from "./client";
import { useServersStore } from "../stores/servers";
import { __resetScopesForTests, activeScope, noteBootStatus, scopeFor } from "./scope";

describe("setSessionLabel", () => {
  beforeEach(() => {
    tauriFetch.mockReset();
    resetWriteVerbMemory();
    __resetScopesForTests();
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

  const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const okBody = {
    status: 200,
    ok: true,
    text: async () =>
      JSON.stringify({ success: true, label: "qa731", locked: true }),
  };
  const calls = () =>
    tauriFetch.mock.calls as [string, { method?: string; body?: string }][];

  it("POSTs /cli/sessions/label with {id, label} as a JSON body (K2 0.44.4+)", async () => {
    tauriFetch.mockResolvedValue(okBody);
    const r = await setSessionLabel(activeScope(), ID, "qa731");
    expect(r).toMatchObject({
      ok: true,
      data: { success: true, label: "qa731", locked: true },
    });
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = calls()[0];
    expect(url).toBe("http://127.0.0.1:9/cli/sessions/label");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body || "")).toEqual({ id: ID, label: "qa731" });
    expect(opts.body).not.toMatch(/lock/);
  });

  it("falls back to the old GET once when the POST 405s (pre-0.44.4)", async () => {
    tauriFetch
      .mockResolvedValueOnce({
        status: 405,
        ok: false,
        text: async () =>
          JSON.stringify({ error: "method not allowed for this route" }),
      })
      .mockResolvedValueOnce(okBody);
    const r = await setSessionLabel(activeScope(), ID, "qa 731");
    expect(r.ok).toBe(true);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    expect(calls()[0][1].method).toBe("POST");
    const [url, opts] = calls()[1];
    expect(url).toBe(
      `http://127.0.0.1:9/cli/sessions/label?id=${ID}&label=qa%20731`
    );
    expect(url).not.toMatch(/lock=/);
    expect(opts.method).toBe("GET");
    expect(opts.body).toBeUndefined();
  });

  it("does not fall back on a non-405 failure", async () => {
    tauriFetch.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ error: "missing label param" }),
    });
    const r = await setSessionLabel(activeScope(), ID, "qa731");
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces the GET answer when both forms 405", async () => {
    tauriFetch.mockResolvedValue({
      status: 405,
      ok: false,
      text: async () => JSON.stringify({ error: "nope" }),
    });
    const r = await setSessionLabel(activeScope(), ID, "qa731");
    expect(r).toMatchObject({ ok: false, status: 405 });
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("remembers the legacy GET per server only (MA15)", async () => {
    useServersStore.setState({
      servers: [
        { id: "s1", nickname: "old", url: "http://127.0.0.1:9", username: "u", rememberPassword: false },
        { id: "s2", nickname: "new", url: "http://127.0.0.1:10", username: "u", rememberPassword: false },
      ],
      activeServerId: "s1",
      tokens: { s1: "tok", s2: "tok2" },
    });
    tauriFetch
      .mockResolvedValueOnce({ status: 405, ok: false, text: async () => "{}" })
      .mockResolvedValue(okBody);
    await setSessionLabel(scopeFor("s1"), ID, "a");
    // s1 now goes straight to GET; s2 still POSTs.
    await setSessionLabel(scopeFor("s1"), ID, "b");
    await setSessionLabel(scopeFor("s2"), ID, "c");
    const methods = calls().map(([url, o]) => `${o.method ?? "GET"} ${url.split("?")[0]}`);
    expect(methods).toEqual([
      "POST http://127.0.0.1:9/cli/sessions/label",
      "GET http://127.0.0.1:9/cli/sessions/label",
      "GET http://127.0.0.1:9/cli/sessions/label",
      "POST http://127.0.0.1:10/cli/sessions/label",
    ]);
  });

  it("a known version picks the verb without a failed try (MA15)", async () => {
    noteBootStatus("s1", { version: "0.44.3", features: [] });
    expect(writeVerbFor(scopeFor("s1"), "/cli/sessions/label")).toBe("GET");
    noteBootStatus("s1", { version: "0.45.3", features: [] });
    expect(writeVerbFor(scopeFor("s1"), "/cli/sessions/label")).toBe("POST");
    noteBootStatus("s1", { version: "0.44.3", features: [] });
    tauriFetch.mockResolvedValue(okBody);
    await setSessionLabel(scopeFor("s1"), ID, "x");
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(calls()[0][1].method).toBe("GET");
    expect(calls()[0][0]).toContain("/cli/sessions/label?id=");
  });
});
