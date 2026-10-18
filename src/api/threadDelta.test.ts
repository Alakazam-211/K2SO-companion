import { beforeEach, describe, expect, it, vi } from "vitest";

const scoped = vi.fn();
vi.mock("./scopedFetch", () => ({
  NOT_CONNECTED: "Not connected",
  scopedFetch: (...a: unknown[]) => scoped(...a),
}));

import { fakeScope } from "../test/fakeScope";
import {
  DELTA_PARAM,
  FEATURE_THREAD_DELTA,
  deltaSupported,
  fetchProjectGroupDelta,
  fetchThreadDelta,
} from "./threadDelta";
import { DAEMON_FEATURES } from "./scope";

const ok = (body: unknown) => ({ ok: true, status: 200, text: JSON.stringify(body) });

beforeEach(() => scoped.mockReset());

describe("thread delta reads (thread-delta-v1)", () => {
  it("is gated on the server's feature key", () => {
    expect(DAEMON_FEATURES).toContain(FEATURE_THREAD_DELTA);
    expect(deltaSupported(fakeScope())).toBe(false);
    expect(deltaSupported(fakeScope({ features: ["thread-delta-v1"] }))).toBe(true);
  });

  it("asks for items after the cursor and reads has_more / conversation_id", async () => {
    scoped.mockResolvedValueOnce(ok({ conversation_id: "c1", has_more: true, items: [{ id: "a", seq: 6 }] }));
    const r = await fetchThreadDelta(fakeScope(), "appa", 5, 20);
    const [, path, opts] = scoped.mock.calls[0];
    expect(path).toBe("/cli/thread");
    expect(opts.query).toEqual({ addr: "appa", [DELTA_PARAM]: "5", limit: "20" });
    expect(DELTA_PARAM).toBe("after_seq");
    expect(r.ok).toBe(true);
    expect(r.data?.items).toHaveLength(1);
    expect(r.data?.hasMore).toBe(true);
    expect(r.data?.conversationId).toBe("c1");
    expect(r.data?.bytes).toBeGreaterThan(0);
  });

  it("project chats use the same cursor param on the messages route", async () => {
    scoped.mockResolvedValueOnce(ok({ ok: true, messages: [{ id: "g", seq: 12 }], truncated: false }));
    const r = await fetchProjectGroupDelta(fakeScope(), "grp", 11);
    const [, path, opts] = scoped.mock.calls[0];
    expect(path).toBe("/cli/project-group/messages");
    expect(opts.query).toMatchObject({ group: "grp", after_seq: "11" });
    expect(r.data?.hasMore).toBe(false);
  });

  it("HTTP errors and throws come back as failures", async () => {
    scoped.mockResolvedValueOnce({ ok: false, status: 400, text: "{}" });
    expect((await fetchThreadDelta(fakeScope(), "a", 1)).ok).toBe(false);
    scoped.mockRejectedValueOnce(new Error("timed out"));
    const r = await fetchThreadDelta(fakeScope(), "a", 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});
