import { describe, expect, it } from "vitest";
import {
  agentsBackCount,
  badgeShare,
  entryForRow,
  homeBackCount,
  homeRowRefs,
  isReadFrame,
  newestSeenSeq,
  optimisticMute,
  optimisticRead,
  parseUnreadEntry,
  parseUnreadSummary,
  projectBadgeCount,
  projectsBackCount,
  rowRefOf,
  rowUnreadFor,
  rowUnreadOf,
  unreadCountText,
  unreadKey,
  withEntry,
  type ServerUnread,
  type UnreadEntry,
} from "./unread";
import { parseHomeAddress } from "./homes";

const e = (over: Partial<UnreadEntry> & { id: string }): UnreadEntry => ({
  kind: "thread",
  projectId: null,
  lastReadSeq: 0,
  lastSeq: 0,
  unread: 0,
  waiting: 0,
  muted: false,
  mutedUntil: null,
  ...over,
});

function server(entries: UnreadEntry[], total: number, waitingTotal = 0): ServerUnread {
  const byKey: Record<string, UnreadEntry> = {};
  for (const x of entries) byKey[unreadKey(x.kind, x.id)] = x;
  return { byKey, total, waitingTotal, loaded: true };
}

describe("unreadCountText", () => {
  it("hides 0, caps at 99+", () => {
    expect(unreadCountText(0)).toBeNull();
    expect(unreadCountText(-1)).toBeNull();
    expect(unreadCountText(1)).toBe("1");
    expect(unreadCountText(99)).toBe("99");
    expect(unreadCountText(100)).toBe("99+");
  });
});

describe("parsing", () => {
  it("reads a summary and keeps only rows that say something", () => {
    const s = parseUnreadSummary({
      ok: true,
      total: 5,
      waitingTotal: 1,
      byConversation: [
        { kind: "thread", id: "c1", projectId: "p1", seq: 3, lastReadSeq: 3, lastSeq: 7, unread: 4, waiting: 0, muted: false },
        { kind: "project", id: "g1", seq: 1, lastReadSeq: 1, lastSeq: 1, unread: 0, waiting: 1, muted: false },
        { kind: "thread", id: "c2", unread: 0, waiting: 0, muted: false },
        { kind: "thread", id: "c3", unread: 2, waiting: 0, muted: true, mutedUntil: 1_900_000_000 },
      ],
      muted: [{ kind: "thread", id: "c3" }],
    });
    expect(s?.total).toBe(5);
    expect(s?.waitingTotal).toBe(1);
    expect(Object.keys(s!.byKey).sort()).toEqual(["project:g1", "thread:c1", "thread:c3"]);
    expect(s!.byKey["thread:c1"].projectId).toBe("p1");
    expect(s!.byKey["thread:c3"].mutedUntil).toBe(1_900_000_000);
  });

  it("refuses a body that is not a summary", () => {
    expect(parseUnreadSummary({ ok: true })).toBeNull();
    expect(parseUnreadSummary(null)).toBeNull();
  });

  it("reads frame kinds", () => {
    const f = { kind: "project_read", id: "g1", unread: 3, total: 3, waitingTotal: 0 };
    expect(isReadFrame(f)).toBe(true);
    expect(isReadFrame({ kind: "projects_changed" })).toBe(false);
    expect(parseUnreadEntry(f)?.kind).toBe("project");
    expect(parseUnreadEntry({ kind: "thread_read", id: "c1", seq: 4 })?.lastReadSeq).toBe(4);
  });
});

describe("rows ↔ state", () => {
  const s = server(
    [
      e({ id: "conv-main", unread: 3 }),
      e({ id: "conv-side", unread: 1 }),
      e({ kind: "project", id: "g1", waiting: 2 }),
    ],
    6,
    2
  );
  const addrs = { appa: "conv-main", "appa/agent/2": "conv-side" };

  it("matches a main chat and a sidecar by their own addr, a project chat by group", () => {
    expect(entryForRow(s, addrs, rowRefOf({ addr: "Appa" }))?.id).toBe("conv-main");
    expect(entryForRow(s, addrs, rowRefOf({ addr: "appa/agent/2" }))?.id).toBe("conv-side");
    expect(entryForRow(s, addrs, rowRefOf({ kind: "group", groupId: "g1" }))?.id).toBe("g1");
    // Unknown addr (no thread/latest yet): nothing, never a guess.
    expect(entryForRow(s, addrs, rowRefOf({ addr: "momo" }))).toBeNull();
  });

  it("a conversationId on the ref wins over the addr map", () => {
    expect(entryForRow(s, {}, { kind: "thread", addr: "x", conversationId: "conv-main" })?.unread).toBe(3);
  });

  it("row marks: waiting amber first, muted grey, unread blue", () => {
    expect(rowUnreadOf(e({ id: "a", unread: 2 }))).toEqual({ tone: "unread", count: 2, emphasis: true, muted: false });
    expect(rowUnreadOf(e({ id: "a", unread: 2, waiting: 1 }))?.tone).toBe("waiting");
    expect(rowUnreadOf(e({ id: "a", unread: 2, muted: true }))).toEqual({
      tone: "muted",
      count: 2,
      emphasis: false,
      muted: true,
    });
    expect(rowUnreadOf(e({ id: "a", muted: true }))?.count).toBe(0);
    expect(rowUnreadOf(null)).toBeNull();
    expect(rowUnreadFor({ s1: s }, { s1: addrs }, "s1", { addr: "appa" })?.count).toBe(3);
    expect(rowUnreadFor({ s1: s }, { s1: addrs }, "s2", { addr: "appa" })).toBeNull();
  });
});

describe("totals", () => {
  it("badge share leaves muted unread out and keeps waiting", () => {
    expect(badgeShare(e({ id: "a", unread: 4 }))).toBe(4);
    expect(badgeShare(e({ id: "a", unread: 4, muted: true }))).toBe(0);
    expect(badgeShare(e({ id: "a", unread: 4, muted: true, waiting: 1 }))).toBe(1);
  });

  it("Agents back: the server total minus the open chat", () => {
    const s = server([e({ id: "c1", unread: 3 }), e({ id: "c2", unread: 2, waiting: 1 })], 6, 1);
    const addrs = { appa: "c1", momo: "c2" };
    expect(agentsBackCount(s, addrs, { kind: "thread", addr: "appa" })).toBe(3);
    expect(agentsBackCount(s, addrs, { kind: "thread", addr: "momo" })).toBe(3);
    expect(agentsBackCount(s, addrs, null)).toBe(6);
    expect(agentsBackCount(undefined, addrs, null)).toBe(0);
  });

  it("Home back: Home rows on every server, once each, open chat out, muted out", () => {
    const s1 = server([e({ id: "c1", unread: 3 }), e({ id: "c9", unread: 50 })], 53);
    const s2 = server([e({ id: "d1", unread: 2, muted: true }), e({ id: "d2", waiting: 1 })], 1, 1);
    const addrs = { s1: { appa: "c1", zuko: "c9" }, s2: { katara: "d1", toph: "d2" } };
    const rows = [
      { serverId: "s1", ref: { kind: "thread" as const, addr: "appa" } },
      { serverId: "s1", ref: { kind: "thread" as const, addr: "appa" } },
      { serverId: "s2", ref: { kind: "thread" as const, addr: "katara" } },
      { serverId: "s2", ref: { kind: "thread" as const, addr: "toph" } },
    ];
    // zuko (50 unread) is not on the Home: not counted.
    expect(homeBackCount(rows, { s1, s2 }, addrs, null)).toBe(4);
    expect(
      homeBackCount(rows, { s1, s2 }, addrs, { serverId: "s1", ref: { kind: "thread", addr: "appa" } })
    ).toBe(1);
    // The same addr on another server is another chat.
    expect(
      homeBackCount(rows, { s1, s2 }, addrs, { serverId: "s2", ref: { kind: "thread", addr: "appa" } })
    ).toBe(4);
  });

  it("Home rows resolve to saved servers by host", () => {
    const refs = homeRowRefs(
      [{ address: "appa::dtl.k2.dev" }, { address: "momo::gone.k2.dev" }, { address: "bad" }],
      [{ id: "s1", hostKey: "dtl.k2.dev" }],
      parseHomeAddress
    );
    expect(refs).toEqual([{ serverId: "s1", ref: { kind: "thread", addr: "appa" } }]);
  });

  it("Projects back and the Projects badge", () => {
    const s = server(
      [
        e({ kind: "project", id: "g1", unread: 2 }),
        e({ kind: "project", id: "g2", unread: 5, muted: true }),
        e({ kind: "project", id: "g3", waiting: 1, muted: true }),
        e({ id: "c1", unread: 9 }),
      ],
      12,
      1
    );
    expect(projectsBackCount(s, "g1")).toBe(1);
    expect(projectsBackCount(s, null)).toBe(3);
    expect(projectBadgeCount(s)).toBe(2);
  });
});

describe("optimistic changes", () => {
  it("a full read zeroes unread, keeps waiting, drops the total", () => {
    const s = server([e({ id: "c1", unread: 3, waiting: 1, lastReadSeq: 4, lastSeq: 9 })], 4, 1);
    const next = optimisticRead(s, "thread:c1");
    expect(next.byKey["thread:c1"].unread).toBe(0);
    expect(next.byKey["thread:c1"].waiting).toBe(1);
    expect(next.byKey["thread:c1"].lastReadSeq).toBe(9);
    expect(next.total).toBe(1);
  });

  it("a muted read leaves the total alone; a fully read row leaves the map", () => {
    const s = server([e({ id: "c1", unread: 3, lastSeq: 5 }), e({ id: "c2", unread: 2, muted: true, lastSeq: 5 })], 3);
    const a = optimisticRead(s, "thread:c1");
    expect(a.byKey["thread:c1"]).toBeUndefined();
    expect(a.total).toBe(0);
    const b = optimisticRead(s, "thread:c2");
    expect(b.total).toBe(3);
    expect(b.byKey["thread:c2"].muted).toBe(true);
  });

  it("a partial read keeps what is above the seq", () => {
    const s = server([e({ id: "c1", unread: 5, lastReadSeq: 5, lastSeq: 10 })], 5);
    const next = optimisticRead(s, "thread:c1", 8);
    expect(next.byKey["thread:c1"].unread).toBe(2);
    expect(next.total).toBe(2);
  });

  it("mute takes unread out of the total; unmute puts it back", () => {
    const s = server([e({ id: "c1", unread: 3 })], 3);
    const m = optimisticMute(s, s.byKey["thread:c1"], true, null);
    expect(m.total).toBe(0);
    expect(m.byKey["thread:c1"].muted).toBe(true);
    const u = optimisticMute(m, m.byKey["thread:c1"], false, null);
    expect(u.total).toBe(3);
  });

  it("withEntry applies totals from a frame", () => {
    const s = server([], 0);
    const next = withEntry(s, e({ id: "c1", unread: 1 }), { total: 7, waitingTotal: 2 });
    expect(next.total).toBe(7);
    expect(next.waitingTotal).toBe(2);
  });
});

describe("newestSeenSeq", () => {
  it("Threads use seq; project chats their own readSeq; pending sends never count", () => {
    const msgs = [
      { seq: 3, readSeq: 30 },
      { seq: 9, readSeq: 41 },
      { seq: null, pending: true },
    ];
    expect(newestSeenSeq(msgs, "thread")).toBe(9);
    expect(newestSeenSeq(msgs, "project")).toBe(41);
    expect(newestSeenSeq([{ seq: 0 }], "project")).toBeNull();
  });
});
