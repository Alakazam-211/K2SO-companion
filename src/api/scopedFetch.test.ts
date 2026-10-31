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

  it("routes the person waits on are user priority; lists and sync are background", () => {
    expect(priorityOf("/cli/thread")).toBe("user");
    expect(priorityOf("/cli/thread/post")).toBe("user");
    expect(priorityOf("/cli/project-group/messages?limit=50")).toBe("user");
    expect(priorityOf("/cli/thread/catchup")).toBe("background");
    expect(priorityOf("/cli/me/homes")).toBe("background");
  });
});
