// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEntry } from "../stores/servers";
import type { HomeRowView } from "./homeView";
import {
  RECENT_FIRST_KEY,
  RECENT_SENT_KEY,
  homeViewRecent,
  orderRecentFirst,
  readRecentFirst,
  readRecentSent,
  recentSentKey,
  trimRecentSent,
  useRecentFirstStore,
} from "./recentFirst";
import type { StubAgent } from "./stubData";

type Row = { id: string; serverId: string; addr: string; pinned?: boolean };
const row = (id: string, serverId = "s1", pinned = false): Row => ({ id, serverId, addr: id, pinned });
const keyOf = (r: Row) => recentSentKey(r.serverId, r);
const isPinned = (r: Row) => !!r.pinned;
const ids = (rows: Row[]) => rows.map((r) => `${r.serverId}:${r.id}`);

beforeEach(() => {
  localStorage.clear();
  useRecentFirstStore.getState().reload();
});

describe("orderRecentFirst", () => {
  const rows = [row("pin1", "s1", true), row("a"), row("b"), row("pin2", "s1", true), row("c"), row("d")];

  it("pins first in their order, then newest send, then never-messaged in their order", () => {
    const sent = { "s1|t:c": 200, "s1|t:a": 100, "s1|t:pin2": 999 };
    expect(ids(orderRecentFirst(rows, sent, keyOf, isPinned))).toEqual([
      "s1:pin1",
      "s1:pin2",
      "s1:c",
      "s1:a",
      "s1:b",
      "s1:d",
    ]);
  });

  it("nothing sent: the original order (pins still lead)", () => {
    expect(ids(orderRecentFirst(rows, {}, keyOf, isPinned))).toEqual([
      "s1:pin1",
      "s1:pin2",
      "s1:a",
      "s1:b",
      "s1:c",
      "s1:d",
    ]);
    // No pin rule: exactly the input.
    const plain = rows.filter((r) => !r.pinned);
    expect(orderRecentFirst(plain, {}, keyOf)).toEqual(plain);
  });

  it("the same handle on two servers is two keys", () => {
    const two = [row("k2", "s1"), row("ops", "s1"), row("k2", "s2")];
    const sent = { [recentSentKey("s2", { addr: "k2" }) as string]: 50 };
    expect(ids(orderRecentFirst(two, sent, keyOf))).toEqual(["s2:k2", "s1:k2", "s1:ops"]);
  });
});

describe("recentSentKey", () => {
  it("is the list's last-at key, addr lowercased; null without a server or addr", () => {
    expect(recentSentKey("s1", { addr: " Alpha " })).toBe("s1|t:alpha");
    expect(recentSentKey("s2", { addr: "alpha" })).not.toBe(recentSentKey("s1", { addr: "alpha" }));
    expect(recentSentKey("", { addr: "alpha" })).toBeNull();
    expect(recentSentKey("s1", { addr: null })).toBeNull();
  });
});

describe("storage", () => {
  it("the setting defaults off and persists on this phone", () => {
    expect(readRecentFirst()).toBe(false);
    expect(useRecentFirstStore.getState().on).toBe(false);
    useRecentFirstStore.getState().setOn(true);
    expect(localStorage.getItem(RECENT_FIRST_KEY)).toBe("1");
    expect(readRecentFirst()).toBe(true);
    useRecentFirstStore.getState().setOn(false);
    expect(readRecentFirst()).toBe(false);
  });

  it("markSent writes the time; junk in storage reads as empty", () => {
    useRecentFirstStore.getState().markSent("s1|t:a", 10);
    useRecentFirstStore.getState().markSent("s1|t:a", 20);
    useRecentFirstStore.getState().markSent(null, 30);
    expect(useRecentFirstStore.getState().sent).toEqual({ "s1|t:a": 20 });
    expect(readRecentSent()).toEqual({ "s1|t:a": 20 });
    localStorage.setItem(RECENT_SENT_KEY, "[1,2]");
    expect(readRecentSent()).toEqual({});
    localStorage.setItem(RECENT_SENT_KEY, '{"x":"no","y":5}');
    expect(readRecentSent()).toEqual({ y: 5 });
  });

  it("keeps only the newest sends", () => {
    expect(trimRecentSent({ a: 1, b: 3, c: 2 }, 2)).toEqual({ b: 3, c: 2 });
  });
});

describe("homeViewRecent", () => {
  const agent = (id: string, addr: string): StubAgent => ({ id, name: addr, initial: addr[0], addr });
  const B: ServerEntry = { id: "s2", nickname: "B", url: "https://b.k2.dev", username: "u", rememberPassword: false };
  const here = (id: string, addr: string): HomeRowView => ({
    kind: "here",
    row: { address: `${addr}::a.k2.dev`, workspaceId: null, label: addr },
    agent: agent(id, addr),
  });
  const remote = (addr: string, resolved: StubAgent | null): HomeRowView => ({
    kind: "remote",
    row: { address: `${addr}::b.k2.dev`, workspaceId: null, label: addr },
    server: B,
    serverLabel: "B",
    resolved: { loaded: true, agent: resolved, workspaceId: null },
  });
  const views = [here("/x", "x"), remote("docs", agent("/srv/docs", "docs")), here("/pin", "pin"), remote("ops", null)];
  const ctx = homeViewRecent({
    activeServerId: "s1",
    activePinnedIds: ["/pin"],
    remotePinnedIds: (sid) => (sid === "s2" ? ["/srv/docs"] : undefined),
  });

  it("keys each row on its own server; pins come from that server", () => {
    expect(views.map(ctx.keyOf)).toEqual(["s1|t:x", "s2|t:docs", "s1|t:pin", "s2|t:ops"]);
    expect(views.map(ctx.isPinned)).toEqual([false, true, true, false]);
    const sorted = orderRecentFirst(views, { "s2|t:ops": 5, "s1|t:x": 1 }, ctx.keyOf, ctx.isPinned);
    expect(sorted.map((v) => v.row.label)).toEqual(["docs", "pin", "ops", "x"]);
  });
});
