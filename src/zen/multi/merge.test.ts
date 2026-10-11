// The Agents tab's per-server list (multi-server S2): keys and addresses
// (MA8), pins and focus per server (MS19), search within the one server,
// and the Q7 snapshot cap.

import { describe, expect, it } from "vitest";
import {
  buildServerList,
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

describe("buildServerList", () => {
  it("one server's rows only, keyed and addressed on that server (MA8)", () => {
    const { rows } = buildServerList(B, { q: "" });
    expect(rows.map((r) => r.key)).toEqual(["sb|/srv/k2", "sb|/srv/docs"]);
    expect(rows.map((r) => r.address)).toEqual(["k2::b.k2.dev", "docs::b.k2.dev"]);
    expect(rows.find((r) => r.key === "sb|/srv/k2")?.workspaceId).toBe("pb");
    expect(new Set(rows.map((r) => r.serverId))).toEqual(new Set(["sb"]));
  });

  it("no source (signed out, not loaded): empty", () => {
    expect(buildServerList(null, { q: "" })).toEqual({ rows: [], pinned: [] });
  });

  it("pins come from that server's own projects.pinned; none while searching (MS19)", () => {
    expect(buildServerList(A, { q: "" }).pinned.map((r) => r.key)).toEqual(["sa|/w/k2"]);
    expect(buildServerList(B, { q: "" }).pinned.map((r) => r.key)).toEqual(["sb|/srv/docs"]);
    expect(buildServerList(B, { q: "doc" }).pinned).toEqual([]);
  });

  it("the server's own focus group filters its rows; search ignores it (MS19, Q5)", () => {
    const grouped = source({
      ...B,
      serverProjects: [project("pb", "k2", "/srv/k2", { focusGroupId: "work" }), project("pd", "docs", "/srv/docs", { focusGroupId: "home" })],
      pinnedIds: [],
      focus: { enabled: true, currentId: "work", groups: [{ id: "work", name: "Work", color: null }, { id: "home", name: "Home", color: null }] },
    });
    expect(buildServerList(grouped, { q: "" }).rows.map((r) => r.agent.addr)).toEqual(["k2"]);
    expect(buildServerList(grouped, { q: "docs" }).rows.map((r) => r.key)).toEqual(["sb|/srv/docs"]);
  });

  it("search stays inside the one server and never matches its name", () => {
    expect(buildServerList(A, { q: "k2" }).rows.map((r) => r.serverId)).toEqual(["sa", "sa"]);
    expect(buildServerList(B, { q: "bravo" }).rows).toEqual([]);
  });

  it("hidden extras stay hidden until searched", () => {
    const hidden = source({ ...A, hiddenAddrs: ["k2/1"] });
    expect(buildServerList(hidden, { q: "" }).rows.map((r) => r.agent.addr)).toEqual(["k2", null]);
    expect(buildServerList(hidden, { q: "reviewer" }).rows).toHaveLength(1);
  });
});

describe("chips and the snapshot cap", () => {
  it("chips only when more than one server is saved (Q2)", () => {
    expect(showServerChips(0)).toBe(false);
    expect(showServerChips(1)).toBe(false);
    expect(showServerChips(2)).toBe(true);
  });

  it("Q7: at most two servers keep the 5 s snapshot", () => {
    expect(snapshotServerIds({ activeId: "a", selectedId: null })).toEqual(["a"]);
    expect(snapshotServerIds({ activeId: "a", selectedId: "a" })).toEqual(["a"]);
    expect(snapshotServerIds({ activeId: "a", selectedId: "b" })).toEqual(["b", "a"]);
    expect(snapshotServerIds({ activeId: "a", selectedId: "b", roomServerId: "c" })).toEqual(["b", "c"]);
    expect(snapshotServerIds({ activeId: null, selectedId: null })).toEqual([]);
  });
});
