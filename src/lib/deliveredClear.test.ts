import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServersStore } from "../stores/servers";
import type { ServerUnread, UnreadEntry } from "../zen/unread";
import { __setDeliveredClearDepsForTests, clearDelivered, planForEntry, planForSummary } from "./deliveredClear";

const entry = (over: Partial<UnreadEntry>): UnreadEntry => ({
  kind: "thread",
  id: "c1",
  projectId: "p1",
  lastReadSeq: 7,
  lastSeq: 7,
  unread: 0,
  waiting: 0,
  muted: false,
  mutedUntil: null,
  ...over,
});

describe("what a read clears", () => {
  it("a chat read to its end: its notifications up to the cursor", () => {
    expect(planForEntry(entry({}), { total: 3, waitingTotal: 0 })).toEqual({
      mode: "read",
      chats: [{ kind: "thread", id: "c1", seq: 7 }],
    });
    // No cursor yet: all of that chat's earlier notifications.
    expect(planForEntry(entry({ kind: "project", id: "g1", lastReadSeq: 0 }), null)).toEqual({
      mode: "read",
      chats: [{ kind: "project", id: "g1" }],
    });
  });

  it("still unread, or a card waiting: nothing", () => {
    expect(planForEntry(entry({ unread: 2 }), { total: 2, waitingTotal: 0 })).toBeNull();
    expect(planForEntry(entry({ waiting: 1 }), { total: 1, waitingTotal: 1 })).toBeNull();
  });

  it("nothing left unread on the server: everything from it", () => {
    expect(planForEntry(entry({ unread: 2 }), { total: 0, waitingTotal: 0 })).toEqual({ mode: "keepOnly", chats: [] });
  });

  it("the summary keeps only chats still unread (above the cursor) or waiting", () => {
    const s: ServerUnread = {
      loaded: true,
      total: 6,
      waitingTotal: 1,
      byKey: {
        "thread:c1": entry({ unread: 5, lastReadSeq: 2 }),
        "project:g1": entry({ kind: "project", id: "g1", waiting: 1, lastReadSeq: 4 }),
        "thread:c2": entry({ id: "c2", muted: true }),
      },
    };
    expect(planForSummary(s)).toEqual({
      mode: "keepOnly",
      chats: [
        { kind: "thread", id: "c1", seq: 2 },
        { kind: "project", id: "g1" },
      ],
    });
  });
});

describe("clearDelivered", () => {
  const call = vi.fn(async () => ({ removed: 1 }));
  beforeEach(() => {
    call.mockClear();
    useServersStore.setState({
      servers: [
        { id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false },
        { id: "s2", nickname: "", url: "https://example.com", username: "baden", rememberPassword: false },
      ],
    });
    __setDeliveredClearDepsForTests({ supported: async () => true, call, badgeKeyOf: (id) => (id === "s1" ? "a".repeat(32) : null) });
  });

  it("names the server by badgeKey and tunnel label", async () => {
    await clearDelivered("s1", { mode: "read", chats: [{ kind: "thread", id: "c1", seq: 7 }] }, 1234);
    expect(call).toHaveBeenCalledWith("clear_delivered", {
      badgeKey: "a".repeat(32),
      subdomain: "dtl",
      mode: "read",
      chats: [{ kind: "thread", id: "c1", seq: 7 }],
      before: 1234,
    });
  });

  it("does nothing off *.k2.dev, without a plan, or without push", async () => {
    await clearDelivered("s2", { mode: "keepOnly", chats: [] });
    await clearDelivered("s1", null);
    __setDeliveredClearDepsForTests({ supported: async () => false, call });
    await clearDelivered("s1", { mode: "keepOnly", chats: [] });
    expect(call).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    __setDeliveredClearDepsForTests({ supported: async () => true, call: async () => Promise.reject(new Error("x")) });
    await expect(clearDelivered("s1", { mode: "keepOnly", chats: [] })).resolves.toBeUndefined();
  });
});
