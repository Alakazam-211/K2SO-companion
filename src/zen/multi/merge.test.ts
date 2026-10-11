// Merged list (multi-server S2): keys and addresses (MA8), dedupe by
// address (MS16), pins and focus per server (MS19), search across servers
// with chip text (MS20), the server filter (MS35), and the Q7 snapshot cap.

import { describe, expect, it } from "vitest";
import {
  buildMergedList,
  dedupeByAddress,
  orderSources,
  parseRowAddress,
  parseRowKey,
  rowAddress,
  rowKey,
  showServerChips,
  snapshotServerIds,
  workspaceIdForRow,
  type MergedSource,
} from "./merge";
import { FOCUS_OFF, type ServerProject } from "../serverPins";
import type { StubAgent } from "../stubData";

const agent = (id: string, addr: string | null, extra: Partial<StubAgent> = {}): StubAgent => ({
  id,
  name: extra.name ?? (addr || id),
  initial: "X",
  path: extra.path ?? id,
  addr,
  kind: "agent",
  ...extra,
});

const project = (id: string, handle: string, path: string, extra: Partial<ServerProject> = {}): ServerProject => ({
  id,
  name: handle,
  handle,
  path,
  pinned: false,
  tabOrder: 0,
  focusGroupId: null,
  ...extra,
});

function source(over: Partial<MergedSource> & Pick<MergedSource, "serverId" | "hostKey" | "label">): MergedSource {
  return {
    active: false,
    hasLogin: true,
    agents: [],
    serverProjects: [],
    pinnedIds: [],
    focus: FOCUS_OFF,
    hiddenAddrs: [],
    ...over,
  };
}

const A = source({
  serverId: "sa",
  hostKey: "a.k2.dev",
  label: "Alpha",
  active: true,
  agents: [
    agent("/w/k2", "k2", { name: "K2" }),
    agent("/w/k2#k2/1", "k2/1", { name: "K2", chatTitle: "reviewer", path: "/w/k2" }),
    { id: "group:g1", name: "Team", initial: "T", addr: null, kind: "group", groupId: "g1" },
  ],
  serverProjects: [project("pa", "k2", "/w/k2", { pinned: true })],
  pinnedIds: ["/w/k2"],
});
const B = source({
  serverId: "sb",
  hostKey: "b.k2.dev",
  label: "Bravo",
  agents: [agent("/srv/k2", "k2", { name: "K2 on B" }), agent("/srv/docs", "docs", { name: "Docs" })],
  serverProjects: [project("pb", "k2", "/srv/k2"), project("pd", "docs", "/srv/docs", { pinned: true })],
  pinnedIds: ["/srv/docs"],
});

describe("keys and addresses (MA8)", () => {
  it("key = serverId|localId; address = handle::hostKey", () => {
    expect(rowKey("sa", "/w/k2#k2/1")).toBe("sa|/w/k2#k2/1");
    expect(parseRowKey("sa|/w/k2#k2/1")).toEqual({ serverId: "sa", localId: "/w/k2#k2/1" });
    expect(parseRowKey("nobar")).toBe(null);
    expect(rowAddress(A.agents[0], "a.k2.dev")).toBe("k2::a.k2.dev");
    // Phone extension: sidecars keep their slash handle.
    expect(rowAddress(A.agents[1], "a.k2.dev")).toBe("k2/1::a.k2.dev");
    // MA7: group rows get an address too.
    expect(rowAddress(A.agents[2], "a.k2.dev")).toBe("group:g1::a.k2.dev");
    // A row with no handle falls back to its local id.
    expect(rowAddress(agent("agent:x", null), "a.k2.dev")).toBe("agent:x::a.k2.dev");
  });

  it("parses on the LAST ::, keeping a bracketed IPv6 host key whole", () => {
    expect(parseRowAddress("k2/1::a.k2.dev")).toEqual({ handle: "k2/1", hostKey: "a.k2.dev" });
    expect(parseRowAddress("k2::box.lan:8443")).toEqual({ handle: "k2", hostKey: "box.lan:8443" });
    expect(parseRowAddress("k2::[fe80::1]:443")).toEqual({ handle: "k2", hostKey: "[fe80::1]:443" });
    expect(parseRowAddress("no-separator")).toBe(null);
    expect(parseRowAddress("::a.k2.dev")).toBe(null);
  });

  it("workspaceId comes from projects/list on that server (MA12)", () => {
    expect(workspaceIdForRow(A.agents[0], A.serverProjects)).toBe("pa");
    // A sidecar takes its parent workspace's id.
    expect(workspaceIdForRow(A.agents[1], A.serverProjects)).toBe("pa");
    expect(workspaceIdForRow(A.agents[2], A.serverProjects)).toBe(null);
    expect(workspaceIdForRow(agent("/x", "nope"), A.serverProjects)).toBe(null);
  });
});

describe("buildMergedList", () => {
  it("renders every server's rows; the same handle on two servers is two rows (MS16)", () => {
    const { rows } = buildMergedList([B, A], { q: "", filter: "all", chips: true });
    expect(rows.map((r) => r.key)).toEqual([
      "sa|/w/k2",
      "sa|/w/k2#k2/1",
      "sa|group:g1",
      "sb|/srv/k2",
      "sb|/srv/docs",
    ]);
    expect(rows.filter((r) => r.agent.addr === "k2").map((r) => r.address)).toEqual([
      "k2::a.k2.dev",
      "k2::b.k2.dev",
    ]);
    expect(rows.find((r) => r.key === "sb|/srv/k2")?.workspaceId).toBe("pb");
  });

  it("two saved entries sharing a host key give one row: the active / signed-in one (MS2, MA35)", () => {
    const twin = source({ ...B, serverId: "sb2", hostKey: "b.k2.dev", label: "Aardvark", hasLogin: false });
    const { rows } = buildMergedList([twin, B], { q: "", filter: "all", chips: true });
    const docs = rows.filter((r) => r.agent.addr === "docs");
    expect(docs.map((r) => r.serverId)).toEqual(["sb"]);
    expect(orderSources([twin, B, A]).map((s) => s.serverId)).toEqual(["sa", "sb", "sb2"]);
  });

  it("pins come from each server's own projects.pinned, keyed by row key (MS19)", () => {
    const { pinned } = buildMergedList([A, B], { q: "", filter: "all", chips: true });
    expect(pinned.map((r) => r.key)).toEqual(["sa|/w/k2", "sb|/srv/docs"]);
    expect(buildMergedList([A, B], { q: "doc", filter: "all", chips: true }).pinned).toEqual([]);
  });

  it("each server's own focus group filters only its own rows (MS19, Q5)", () => {
    const grouped = source({
      ...B,
      serverProjects: [project("pb", "k2", "/srv/k2", { focusGroupId: "work" }), project("pd", "docs", "/srv/docs", { focusGroupId: "home" })],
      pinnedIds: [],
      focus: { enabled: true, currentId: "work", groups: [{ id: "work", name: "Work", color: null }, { id: "home", name: "Home", color: null }] },
    });
    const { rows } = buildMergedList([A, grouped], { q: "", filter: "all", chips: true });
    expect(rows.filter((r) => r.serverId === "sb").map((r) => r.agent.addr)).toEqual(["k2"]);
    // A's rows are untouched by B's group.
    expect(rows.filter((r) => r.serverId === "sa")).toHaveLength(3);
    // Search ignores focus groups.
    expect(buildMergedList([A, grouped], { q: "docs", filter: "all", chips: true }).rows.map((r) => r.key)).toEqual(["sb|/srv/docs"]);
  });

  it("search runs across servers and matches the chip text when chips show (MS20)", () => {
    const hits = buildMergedList([A, B], { q: "k2", filter: "all", chips: true }).rows;
    expect(hits.map((r) => r.serverId)).toEqual(["sa", "sa", "sb"]);
    const byChip = buildMergedList([A, B], { q: "bravo", filter: "all", chips: true }).rows;
    expect(byChip.map((r) => r.key)).toEqual(["sb|/srv/k2", "sb|/srv/docs"]);
    expect(buildMergedList([A, B], { q: "bravo", filter: "all", chips: false }).rows).toEqual([]);
  });

  it("hidden extras stay hidden per server until searched", () => {
    const hidden = source({ ...A, hiddenAddrs: ["k2/1"] });
    expect(buildMergedList([hidden], { q: "", filter: "all", chips: false }).rows.map((r) => r.agent.addr)).toEqual([
      "k2",
      null,
    ]);
    expect(buildMergedList([hidden], { q: "reviewer", filter: "all", chips: false }).rows).toHaveLength(1);
  });

  it("the server filter keeps one server's rows and pins (MS35)", () => {
    const only = buildMergedList([A, B], { q: "", filter: "sb", chips: true });
    expect(new Set(only.rows.map((r) => r.serverId))).toEqual(new Set(["sb"]));
    expect(only.pinned.map((r) => r.key)).toEqual(["sb|/srv/docs"]);
  });

  it("dedupeByAddress keeps the first", () => {
    const rows = buildMergedList([A], { q: "", filter: "all", chips: false }).rows;
    expect(dedupeByAddress([...rows, ...rows])).toHaveLength(rows.length);
  });
});

describe("chips and the snapshot cap", () => {
  it("chips only when more than one server is saved (Q2)", () => {
    expect(showServerChips(0)).toBe(false);
    expect(showServerChips(1)).toBe(false);
    expect(showServerChips(2)).toBe(true);
  });

  it("Q7: at most two servers keep the 5 s snapshot", () => {
    expect(snapshotServerIds({ activeId: "a", filter: "all" })).toEqual(["a"]);
    expect(snapshotServerIds({ activeId: "a", filter: "a" })).toEqual(["a"]);
    expect(snapshotServerIds({ activeId: "a", filter: "b" })).toEqual(["b", "a"]);
    expect(snapshotServerIds({ activeId: "a", filter: "b", roomServerId: "c" })).toEqual(["b", "c"]);
    expect(snapshotServerIds({ activeId: null, filter: "all" })).toEqual([]);
  });
});
