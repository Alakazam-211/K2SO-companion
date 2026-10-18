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
  goneStatus,
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

  it("parses changed (upsert) and removed ({id, seq}) on the Thread route", async () => {
    scoped.mockResolvedValueOnce(
      ok({
        conversation_id: "c1",
        after_seq: 7,
        items: [],
        has_more: false,
        changed: [{ id: "d6", seq: 6, doc: { kind: "choice" } }],
        removed: [{ id: "d3", seq: 3 }, { id: "", seq: 1 }, "junk", { id: "d4" }],
      })
    );
    const r = await fetchThreadDelta(fakeScope(), "sales", 7);
    expect(r.data?.changed).toHaveLength(1);
    expect(r.data?.removed).toEqual([
      { id: "d3", seq: 3 },
      { id: "d4", seq: null },
    ]);
  });

  it("an answer without changed / removed reads as empty", async () => {
    scoped.mockResolvedValueOnce(ok({ items: [] }));
    const r = await fetchThreadDelta(fakeScope(), "a", 1);
    expect(r.data?.changed).toEqual([]);
    expect(r.data?.removed).toEqual([]);
  });

  it("project has_more / truncated mean newer lines remain; 404 = project gone", async () => {
    scoped.mockResolvedValueOnce(ok({ ok: true, messages: [], has_more: true, truncated: true, changed: [], removed: [] }));
    expect((await fetchProjectGroupDelta(fakeScope(), "g", 2)).data?.hasMore).toBe(true);
    scoped.mockResolvedValueOnce({ ok: false, status: 404, text: JSON.stringify({ ok: false, error: { code: "not_found", hint: "no such project" } }) });
    const r = await fetchProjectGroupDelta(fakeScope(), "g", 2);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toBe("no such project");
    expect(goneStatus(r.status)).toBe(true);
    expect(goneStatus(500)).toBe(false);
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
