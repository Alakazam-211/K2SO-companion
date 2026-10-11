import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import {
  FEATURE_THREAD_PUSH,
  getBootStatus,
  getNotifyPrefs,
  parseNotifyPrefs,
  serverHasFeature,
  setNotifyPrefs,
} from "./client";
import { useServersStore } from "../stores/servers";
import { __resetScopesForTests, scopeFor } from "./scope";

const ok = (body: unknown) => ({
  status: 200,
  ok: true,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const PREFS = {
  ok: true,
  principal: "owner",
  server: { enabled: true, source: "fallback" },
  default: true,
  devices: 1,
  push: "ready",
  workspaces: [
    { projectId: "p1", name: "k2", handle: "k2", threadPush: false, source: "user", updatedBy: "gina", updatedAt: 1 },
    { projectId: "p2", name: "web", handle: "web", threadPush: true, source: "default" },
  ],
};

beforeEach(() => {
  tauriFetch.mockReset();
  __resetScopesForTests();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "u", rememberPassword: false },
      { id: "s2", nickname: "Work", url: "https://work.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok1", s2: "tok2" },
  });
});
afterEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
});

describe("notify prefs API", () => {
  it("GET /cli/notify/prefs on the scope's server", async () => {
    tauriFetch.mockResolvedValue(ok(PREFS));
    const r = await getNotifyPrefs(scopeFor("s1"));
    expect(r.ok).toBe(true);
    const [url, opts] = tauriFetch.mock.calls[0] as [string, { method?: string; headers: Record<string, string> }];
    expect(url).toBe("https://home.k2.dev/cli/notify/prefs");
    expect(opts.method).toBe("GET");
    expect(JSON.stringify(opts.headers)).toContain("tok1");
  });

  it("POST goes to the NAMED server with its own token", async () => {
    tauriFetch.mockResolvedValue(ok(PREFS));
    await setNotifyPrefs(scopeFor("s2"), { server: { enabled: false } });
    const [url, opts] = tauriFetch.mock.calls[0] as [string, { method?: string; body?: string; headers: Record<string, string> }];
    expect(url).toBe("https://work.k2.dev/cli/notify/prefs");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body || "{}")).toEqual({ server: { enabled: false } });
    expect(JSON.stringify(opts.headers)).toContain("tok2");
    expect(JSON.stringify(opts.headers)).not.toContain("tok1");
  });

  it("a workspace reset sends threadPush null", async () => {
    tauriFetch.mockResolvedValue(ok(PREFS));
    await setNotifyPrefs(scopeFor("s1"), { workspace: { projectId: "p1", threadPush: null } });
    const body = JSON.parse((tauriFetch.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ workspace: { projectId: "p1", threadPush: null } });
  });

  it("parses the prefs shape and rejects junk", () => {
    const p = parseNotifyPrefs(PREFS)!;
    expect(p.server).toEqual({ enabled: true, source: "fallback" });
    expect(p.push).toBe("ready");
    expect(p.workspaces[0]).toMatchObject({ projectId: "p1", threadPush: false, source: "user", updatedBy: "gina" });
    expect(p.workspaces[1].updatedBy).toBeUndefined();
    expect(parseNotifyPrefs({ ok: true })).toBeNull();
    expect(parseNotifyPrefs(null)).toBeNull();
  });
});

describe("boot-status features", () => {
  it("reads features + instanceId, unauthenticated, cached per server", async () => {
    tauriFetch.mockResolvedValue(ok({ version: "0.45.5", instanceId: "abc", features: [FEATURE_THREAD_PUSH] }));
    const b = await getBootStatus(scopeFor("s1"));
    expect(b).toEqual({ version: "0.45.5", instanceId: "abc", features: [FEATURE_THREAD_PUSH] });
    const [url, opts] = tauriFetch.mock.calls[0] as [string, { headers?: unknown }];
    expect(url).toBe("https://home.k2.dev/boot-status");
    expect(JSON.stringify(opts.headers ?? {})).not.toContain("tok1");
    expect(await serverHasFeature(scopeFor("s1"), FEATURE_THREAD_PUSH)).toBe(true);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    await getBootStatus(scopeFor("s1"), { fresh: true });
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("an older daemon (no features) or a failure reads as unsupported", async () => {
    tauriFetch.mockResolvedValueOnce(ok({ version: "0.45.4", instanceId: "x" }));
    expect(await serverHasFeature(scopeFor("s2"), FEATURE_THREAD_PUSH)).toBe(false);
    __resetScopesForTests();
    tauriFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await serverHasFeature(scopeFor("s2"), FEATURE_THREAD_PUSH)).toBe(false);
  });

  it("a fresh read that fails is null, never the last good answer", async () => {
    tauriFetch.mockResolvedValueOnce(ok({ version: "0.45.5", instanceId: "abc", features: [] }));
    expect((await getBootStatus(scopeFor("s1")))?.instanceId).toBe("abc");
    tauriFetch.mockResolvedValueOnce({ status: 502, ok: false, text: async () => "" });
    expect(await getBootStatus(scopeFor("s1"), { fresh: true })).toBeNull();
  });
});
