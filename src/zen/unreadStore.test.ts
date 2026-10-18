import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/threadRead", () => ({
  getThreadUnread: vi.fn(),
  postThreadRead: vi.fn(),
  postProjectRead: vi.fn(),
  postThreadMute: vi.fn(),
}));
vi.mock("../lib/badgeTotals", () => ({
  setServerTotals: vi.fn(),
  clearServerTotals: vi.fn(),
  onBadgeTotals: vi.fn(async () => () => {}),
}));

import * as api from "../api/threadRead";
import * as badge from "../lib/badgeTotals";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { __resetUnreadStoreForTests, unreadSupported, useUnreadStore } from "./unreadStore";
import { badgeKeyOf } from "../lib/badgeKeys";

const FEATURES = { features: ["thread-read-v1"] };

const summary = {
  ok: true,
  person: "owner",
  total: 6,
  waitingTotal: 1,
  byConversation: [
    { kind: "thread", id: "c1", projectId: "p1", seq: 2, lastReadSeq: 2, lastSeq: 7, unread: 5, waiting: 0, muted: false },
    { kind: "project", id: "g1", seq: 0, lastReadSeq: 0, lastSeq: 0, unread: 0, waiting: 1, muted: false },
  ],
  muted: [],
};

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetScopesForTests();
  __resetUnreadStoreForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false },
      { id: "s2", nickname: "", url: "https://old.k2.dev", username: "baden", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok", s2: "tok2" },
  });
  noteBootStatus("s1", FEATURES);
  noteBootStatus("s2", { features: ["thread-latest"] });
  vi.mocked(api.getThreadUnread).mockResolvedValue({ ok: true, data: summary });
});

describe("gating", () => {
  it("a server without thread-read-v1 is never asked and shows nothing", async () => {
    expect(unreadSupported("s1")).toBe(true);
    expect(unreadSupported("s2")).toBe(false);
    await useUnreadStore.getState().refresh("s2");
    expect(api.getThreadUnread).not.toHaveBeenCalled();
    expect(useUnreadStore.getState().servers.s2).toBeUndefined();
    useUnreadStore.getState().applyFrame("s2", { kind: "thread_read", id: "x", unread: 3, total: 3, waitingTotal: 0 });
    expect(useUnreadStore.getState().servers.s2).toBeUndefined();
    expect(badge.setServerTotals).not.toHaveBeenCalled();
  });

  it("no login: not supported", () => {
    useServersStore.setState({ tokens: { s1: "" } });
    expect(unreadSupported("s1")).toBe(false);
  });

  it("a server that lost the feature drops its slice and its badge share", async () => {
    await useUnreadStore.getState().refresh("s1");
    expect(useUnreadStore.getState().servers.s1).toBeDefined();
    noteBootStatus("s1", { features: [] });
    await useUnreadStore.getState().refresh("s1");
    expect(useUnreadStore.getState().servers.s1).toBeUndefined();
    expect(badge.clearServerTotals).toHaveBeenCalledWith("s1");
  });
});

describe("fetch", () => {
  it("reads the summary on that server and feeds the badge", async () => {
    await useUnreadStore.getState().refresh("s1");
    const s = useUnreadStore.getState().servers.s1;
    expect(s.total).toBe(6);
    expect(s.byKey["thread:c1"].unread).toBe(5);
    expect(vi.mocked(api.getThreadUnread).mock.calls[0][0].id).toBe("s1");
    expect(badge.setServerTotals).toHaveBeenCalledWith("s1", { unread: 6, waiting: 1 });
  });

  it("learns the summary's badgeKey before feeding the badge (K2 0.46.1)", async () => {
    vi.mocked(api.getThreadUnread).mockResolvedValue({ ok: true, data: { ...summary, badgeKey: "bkS1" } });
    let keyAtTotals: string | null = null;
    vi.mocked(badge.setServerTotals).mockImplementation(() => {
      keyAtTotals = badgeKeyOf("s1");
    });
    await useUnreadStore.getState().refresh("s1");
    expect(badgeKeyOf("s1")).toBe("bkS1");
    expect(keyAtTotals).toBe("bkS1");
  });

  it("minGapMs skips a read that started recently", async () => {
    await useUnreadStore.getState().refresh("s1");
    await useUnreadStore.getState().refresh("s1", { minGapMs: 30_000 });
    expect(api.getThreadUnread).toHaveBeenCalledTimes(1);
  });

  it("a failed read keeps what is shown", async () => {
    await useUnreadStore.getState().refresh("s1");
    vi.mocked(api.getThreadUnread).mockResolvedValueOnce({ ok: false, error: "boom" });
    await useUnreadStore.getState().refresh("s1");
    expect(useUnreadStore.getState().servers.s1.total).toBe(6);
  });
});

describe("frames", () => {
  it("replace one conversation and the totals, and feed the badge", async () => {
    await useUnreadStore.getState().refresh("s1");
    vi.mocked(badge.setServerTotals).mockClear();
    useUnreadStore.getState().applyFrame("s1", {
      kind: "thread_read",
      id: "c1",
      projectId: "p1",
      seq: 7,
      lastReadSeq: 7,
      lastSeq: 7,
      unread: 0,
      waiting: 0,
      muted: false,
      total: 1,
      waitingTotal: 1,
    });
    const s = useUnreadStore.getState().servers.s1;
    expect(s.byKey["thread:c1"]).toBeUndefined();
    expect(s.total).toBe(1);
    expect(badge.setServerTotals).toHaveBeenCalledWith("s1", { unread: 1, waiting: 1 });
  });

  it("a project frame with a new message adds the row", async () => {
    await useUnreadStore.getState().refresh("s1");
    useUnreadStore.getState().applyFrame("s1", {
      kind: "project_read",
      id: "g2",
      unread: 2,
      waiting: 0,
      muted: false,
      total: 8,
      waitingTotal: 1,
    });
    expect(useUnreadStore.getState().servers.s1.byKey["project:g2"].unread).toBe(2);
  });
});

describe("markRead", () => {
  beforeEach(async () => {
    await useUnreadStore.getState().refresh("s1");
    useUnreadStore.getState().noteAddr("s1", "appa", "c1");
  });

  it("is optimistic, then takes the server's answer", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(api.postThreadRead).mockReturnValue(
      new Promise((r) => {
        answer = r as (v: unknown) => void;
      }) as ReturnType<typeof api.postThreadRead>
    );
    const p = useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "appa" }, 7);
    // Optimistic: zero at once, total down by 5.
    expect(useUnreadStore.getState().servers.s1.byKey["thread:c1"]).toBeUndefined();
    expect(useUnreadStore.getState().servers.s1.total).toBe(1);
    expect(api.postThreadRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { conversationId: "c1", addr: "appa" },
      7
    );
    // The server counted one more post meanwhile.
    answer({
      ok: true,
      data: { ok: true, changed: true, kind: "thread", id: "c1", seq: 7, lastReadSeq: 7, lastSeq: 8, unread: 1, waiting: 0, muted: false, total: 2, waitingTotal: 1 },
    });
    await p;
    const s = useUnreadStore.getState().servers.s1;
    expect(s.byKey["thread:c1"].unread).toBe(1);
    expect(s.total).toBe(2);
    expect(badge.setServerTotals).toHaveBeenLastCalledWith("s1", { unread: 2, waiting: 1 });
  });

  it("nothing unread there: no POST; waiting is not cleared by reading", async () => {
    await useUnreadStore.getState().markRead("s1", { kind: "project", groupId: "g1" });
    expect(api.postProjectRead).not.toHaveBeenCalled();
    expect(useUnreadStore.getState().servers.s1.byKey["project:g1"].waiting).toBe(1);
  });

  it("a seq at or under the cursor sends nothing", async () => {
    await useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "appa" }, 2);
    expect(api.postThreadRead).not.toHaveBeenCalled();
  });

  it("an unknown addr sends nothing", async () => {
    await useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "momo" }, 9);
    expect(api.postThreadRead).not.toHaveBeenCalled();
  });

  it("one in flight per conversation; the newest asked meanwhile follows", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(api.postThreadRead)
      .mockReturnValueOnce(
        new Promise((r) => {
          answer = r as (v: unknown) => void;
        }) as ReturnType<typeof api.postThreadRead>
      )
      .mockResolvedValue({
        ok: true,
        data: { kind: "thread", id: "c1", lastReadSeq: 7, lastSeq: 7, unread: 0, waiting: 0, muted: false, total: 1, waitingTotal: 1 },
      });
    const p = useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "appa" }, 5);
    // Optimistic state now says read to 5 with unread 2 left; a later seq queues.
    await useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "appa" }, 7);
    expect(api.postThreadRead).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      data: { kind: "thread", id: "c1", lastReadSeq: 5, lastSeq: 7, unread: 2, waiting: 0, muted: false, total: 3, waitingTotal: 1 },
    });
    await p;
    await flush();
    expect(api.postThreadRead).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.postThreadRead).mock.calls[1][2]).toBe(7);
    expect(useUnreadStore.getState().servers.s1.total).toBe(1);
  });

  it("a failed POST re-reads the truth", async () => {
    vi.mocked(api.postThreadRead).mockResolvedValue({ ok: false, error: "nope", status: 500 });
    await useUnreadStore.getState().markRead("s1", { kind: "thread", addr: "appa" });
    await flush();
    expect(api.getThreadUnread).toHaveBeenCalledTimes(2);
    expect(useUnreadStore.getState().servers.s1.byKey["thread:c1"].unread).toBe(5);
  });

  it("project chats post project-group/read", async () => {
    useUnreadStore.getState().applyFrame("s1", { kind: "project_read", id: "g2", lastReadSeq: 1, lastSeq: 4, unread: 3, total: 9, waitingTotal: 1 });
    vi.mocked(api.postProjectRead).mockResolvedValue({
      ok: true,
      data: { kind: "project", id: "g2", lastReadSeq: 4, lastSeq: 4, unread: 0, waiting: 0, muted: false, total: 6, waitingTotal: 1 },
    });
    await useUnreadStore.getState().markRead("s1", { kind: "project", groupId: "g2" }, 4);
    expect(api.postProjectRead).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "g2", 4);
    expect(useUnreadStore.getState().servers.s1.total).toBe(6);
  });
});

describe("setMuted", () => {
  beforeEach(async () => {
    await useUnreadStore.getState().refresh("s1");
    useUnreadStore.getState().noteAddr("s1", "appa", "c1");
  });

  it("mutes for a while: optimistic, the route, then the reply", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.mocked(api.postThreadMute).mockResolvedValue({
      ok: true,
      data: { kind: "thread", id: "c1", lastReadSeq: 2, lastSeq: 7, unread: 5, waiting: 0, muted: true, mutedUntil: 1_800_003_600, total: 1, waitingTotal: 1 },
    });
    const p = useUnreadStore.getState().setMuted("s1", { kind: "thread", addr: "appa" }, true, 3600);
    expect(useUnreadStore.getState().servers.s1.byKey["thread:c1"].muted).toBe(true);
    expect(useUnreadStore.getState().servers.s1.total).toBe(1);
    expect(await p).toBe(true);
    expect(api.postThreadMute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { kind: "thread", conversationId: "c1", addr: "appa" },
      true,
      1_800_003_600
    );
    expect(useUnreadStore.getState().servers.s1.byKey["thread:c1"].mutedUntil).toBe(1_800_003_600);
    vi.restoreAllMocks();
  });

  it("unmuting a project chat", async () => {
    vi.mocked(api.postThreadMute).mockResolvedValue({
      ok: true,
      data: { kind: "project", id: "g1", unread: 0, waiting: 1, muted: false, total: 6, waitingTotal: 1 },
    });
    await useUnreadStore.getState().setMuted("s1", { kind: "project", groupId: "g1" }, false);
    expect(api.postThreadMute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { kind: "project", group: "g1" },
      false,
      undefined
    );
  });

  it("a refused mute re-reads the truth", async () => {
    vi.mocked(api.postThreadMute).mockResolvedValue({ ok: false, error: "403", status: 403 });
    expect(await useUnreadStore.getState().setMuted("s1", { kind: "thread", addr: "appa" }, true)).toBe(false);
    await flush();
    expect(useUnreadStore.getState().servers.s1.byKey["thread:c1"].muted).toBe(false);
  });
});
