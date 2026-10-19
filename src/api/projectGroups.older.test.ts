import { beforeEach, describe, expect, it, vi } from "vitest";

// K2 0.46.2 `project-chat-paging-v1`: older pages of a project chat
// (`before_seq`) — the wire wrapper.

const scoped = vi.fn();
vi.mock("./scopedFetch", () => ({
  NOT_CONNECTED: "Not connected",
  scopedFetch: (...a: unknown[]) => scoped(...a),
}));

import { fakeScope } from "../test/fakeScope";
import { OLDER_PAGE_LIMIT, fetchProjectGroupOlder } from "./projectGroups";

const ok = (body: unknown) => ({ ok: true, status: 200, text: JSON.stringify(body) });
const line = (seq: number) => ({ id: `l${seq}`, groupId: "g-1", author: "owner", body: `pc${seq}`, createdAt: seq, seq });

beforeEach(() => scoped.mockReset());

describe("fetchProjectGroupOlder (before_seq)", () => {
  it("asks for lines before the cursor, 50 by default, and reads has_more", async () => {
    scoped.mockResolvedValueOnce(
      ok({ ok: true, groupId: "g-1", before_seq: 71, messages: [line(21), line(22)], has_more: true, truncated: true })
    );
    const r = await fetchProjectGroupOlder(fakeScope(), "g-1", 71);
    const [, path, opts] = scoped.mock.calls[0];
    expect(path).toBe("/cli/project-group/messages");
    expect(opts.method).toBe("GET");
    expect(opts.query).toEqual({ group: "g-1", before_seq: "71", limit: String(OLDER_PAGE_LIMIT) });
    expect(OLDER_PAGE_LIMIT).toBe(50);
    expect("after_seq" in opts.query || "after" in opts.query).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.data?.messages.map((m) => m.seq)).toEqual([21, 22]);
    expect(r.data?.hasMore).toBe(true);
  });

  it("has_more false: the start of the chat (an empty page too)", async () => {
    scoped.mockResolvedValueOnce(ok({ ok: true, messages: [line(1)], has_more: false, truncated: false }));
    expect((await fetchProjectGroupOlder(fakeScope(), "g-1", 2, 10)).data).toEqual({
      messages: [line(1)],
      hasMore: false,
    });
    expect(scoped.mock.calls[0][2].query.limit).toBe("10");
    scoped.mockResolvedValueOnce(ok({ ok: true, messages: [], has_more: false, truncated: false }));
    expect((await fetchProjectGroupOlder(fakeScope(), "g-1", 1)).data).toEqual({ messages: [], hasMore: false });
  });

  it("a failure keeps its HTTP status and hint", async () => {
    scoped.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: JSON.stringify({ ok: false, error: { code: "not_found", hint: "no such project" } }),
    });
    const r = await fetchProjectGroupOlder(fakeScope(), "g-1", 5);
    expect(r).toEqual({ ok: false, error: "no such project", status: 404 });
    scoped.mockResolvedValueOnce({ ok: false, status: 400, text: JSON.stringify({ ok: false, error: { code: "usage" } }) });
    expect(await fetchProjectGroupOlder(fakeScope(), "g-1", 5)).toEqual({ ok: false, error: "usage", status: 400 });
  });

  it("an answer without messages is a failure, not an empty page", async () => {
    scoped.mockResolvedValueOnce(ok({ ok: true }));
    expect((await fetchProjectGroupOlder(fakeScope(), "g-1", 5)).ok).toBe(false);
  });

  it("a server that did not answer reads as unreachable", async () => {
    scoped.mockRejectedValueOnce(new Error("timeout"));
    const r = await fetchProjectGroupOlder(fakeScope(), "g-1", 5);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not reach server/);
  });
});
