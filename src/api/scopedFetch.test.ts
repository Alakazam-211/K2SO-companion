import { beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => http.fetch(...a) }));

import { __resetHttpCapForTests } from "./httpCap";
import { priorityOf, scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";

const scope = { id: "s1", httpBase: () => "https://a.k2.dev", token: () => "tok" } as unknown as ServerScope;

beforeEach(() => {
  __resetHttpCapForTests();
  http.fetch.mockReset();
});

describe("scopedFetch (speed PRD A4)", () => {
  it("a timeout aborts the request instead of leaving it running", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    http.fetch.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    const p = scopedFetch(scope, "/cli/agent/list", { timeoutMs: 1000, revive: false });
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await caught).toBe("Request timed out");
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("the timeout covers the headers only: a slow body still arrives", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finishBody: (t: string) => void = () => {};
    http.fetch.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      signal = init.signal;
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => "" },
        text: () => new Promise<string>((r) => (finishBody = r)),
      });
    });
    const p = scopedFetch(scope, "/cli/thread/attachment", { timeoutMs: 1000, revive: false });
    await vi.advanceTimersByTimeAsync(5000);
    finishBody("big");
    expect((await p).text).toBe("big");
    expect(signal?.aborted).toBe(false);
    vi.useRealTimers();
  });

  it("a GET that fails at once (a dead kept-alive connection) goes again once; a POST never", async () => {
    http.fetch
      .mockRejectedValueOnce(new Error("connection closed before message completed"))
      .mockResolvedValueOnce({ status: 200, ok: true, headers: { get: () => "" }, text: async () => "ok" });
    expect((await scopedFetch(scope, "/cli/agent/list", { revive: false })).text).toBe("ok");
    expect(http.fetch).toHaveBeenCalledTimes(2);
    http.fetch.mockReset().mockRejectedValueOnce(new Error("connection closed before message completed"));
    await expect(scopedFetch(scope, "/cli/thread/post", { method: "POST", body: "{}", revive: false })).rejects.toThrow();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it("routes the person waits on are user priority; lists and sync are background", () => {
    expect(priorityOf("/cli/thread")).toBe("user");
    expect(priorityOf("/cli/thread/post")).toBe("user");
    expect(priorityOf("/cli/project-group/messages?limit=50")).toBe("user");
    expect(priorityOf("/cli/project-group/msg")).toBe("user");
    expect(priorityOf("/cli/thread/catchup")).toBe("background");
    expect(priorityOf("/cli/me/homes")).toBe("background");
  });
});
