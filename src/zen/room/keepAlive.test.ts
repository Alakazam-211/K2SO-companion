// MS24 as amended by MA16: room keep-alive.
//   - open and focus send; input only after an idle hour (each input
//     resets the clock); hourly only while open AND foregrounded;
//   - at most one `projects/activate` per (server, project) per 10 min,
//     single-flight; another server or project is its own key;
//   - a restart (instanceId change) clears that server's dedupe;
//   - the project id must be one `projects/list` lists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as Array<{ server: string; projectId: string }> }));
vi.mock("../../api/client", () => ({
  activateProject: vi.fn(async (scope: { id: string }, projectId: string) => {
    calls.list.push({ server: scope.id, projectId });
    return { ok: true, data: { ok: true } };
  }),
}));

import { fakeScope } from "../../test/fakeScope";
import {
  KEEP_ALIVE_DEDUPE_MS,
  KEEP_ALIVE_HOT_INTERVAL_MS,
  KEEP_ALIVE_IDLE_MS,
  __resetKeepAliveForTests,
  createRoomKeepAlive,
  keepRoomAlive,
  resetKeepAlive,
  roomProjectId,
} from "./keepAlive";

const B = fakeScope({ id: "b", base: "https://b.k2.dev" });
const C = fakeScope({ id: "c", base: "https://c.k2.dev" });

beforeEach(() => {
  vi.useFakeTimers();
  calls.list = [];
  __resetKeepAliveForTests(() => Date.now());
});
afterEach(() => vi.useRealTimers());

describe("keep-alive dedupe", () => {
  it("one send per (server, project) per 10 min, single-flight", async () => {
    const [r1, r2] = await Promise.all([keepRoomAlive(B, "p1"), keepRoomAlive(B, "p1")]);
    expect([r1, r2]).toEqual(["sent", "deduped"]);
    expect(await keepRoomAlive(B, "p1")).toBe("deduped");
    vi.advanceTimersByTime(KEEP_ALIVE_DEDUPE_MS - 1);
    expect(await keepRoomAlive(B, "p1")).toBe("deduped");
    vi.advanceTimersByTime(1);
    expect(await keepRoomAlive(B, "p1")).toBe("sent");
    expect(calls.list).toEqual([
      { server: "b", projectId: "p1" },
      { server: "b", projectId: "p1" },
    ]);
  });

  it("another server or project is its own key; a restart clears only that server", async () => {
    await keepRoomAlive(B, "p1");
    await keepRoomAlive(C, "p1");
    await keepRoomAlive(B, "p2");
    expect(calls.list).toHaveLength(3);
    resetKeepAlive("b");
    expect(await keepRoomAlive(B, "p1")).toBe("sent");
    expect(await keepRoomAlive(C, "p1")).toBe("deduped");
  });
});

describe("room keep-alive rules", () => {
  it("open sends; focus within 10 min is deduped; input sends only after an idle hour", async () => {
    const ka = createRoomKeepAlive(B, "p1");
    ka.opened();
    await Promise.resolve();
    ka.focused();
    await Promise.resolve();
    expect(calls.list).toHaveLength(1);
    vi.advanceTimersByTime(KEEP_ALIVE_IDLE_MS - 1000);
    ka.input(); // not idle long enough: resets the clock
    vi.advanceTimersByTime(KEEP_ALIVE_IDLE_MS - 1000);
    ka.input();
    await Promise.resolve();
    expect(calls.list).toHaveLength(1);
    vi.advanceTimersByTime(KEEP_ALIVE_IDLE_MS);
    ka.input();
    await Promise.resolve();
    expect(calls.list).toHaveLength(2);
    ka.dispose();
  });

  it("hourly only while hot (open + foreground)", async () => {
    const ka = createRoomKeepAlive(B, "p1");
    ka.setHot(true);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_HOT_INTERVAL_MS);
    expect(calls.list).toHaveLength(1);
    ka.setHot(false); // background
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_HOT_INTERVAL_MS * 3);
    expect(calls.list).toHaveLength(1);
    ka.setHot(true);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_HOT_INTERVAL_MS);
    expect(calls.list).toHaveLength(2);
    ka.dispose();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_HOT_INTERVAL_MS * 2);
    expect(calls.list).toHaveLength(2);
  });

  it("the project id comes from projects/list: main handle, then the path; never a guess", () => {
    const projects = [
      { id: "pk", name: "K2", handle: "k2", path: "/ws", pinned: false, tabOrder: 0, focusGroupId: null },
    ] as never;
    expect(roomProjectId({ kind: "agent", addr: "k2/reviewer", path: "/ws" }, projects)).toBe("pk");
    expect(roomProjectId({ kind: "agent", addr: "conv-uuid-like", path: "/ws" }, projects)).toBe("pk");
    expect(roomProjectId({ kind: "agent", addr: "other", path: "/elsewhere" }, projects)).toBeNull();
    expect(roomProjectId({ kind: "group", addr: "g", path: "/ws" }, projects)).toBeNull();
  });
});
