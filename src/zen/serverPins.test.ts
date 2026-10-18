import { describe, expect, it } from "vitest";
import { sortByProjectOrder, type ServerProject,
  FOCUS_OFF,
  derivePinnedIds,
  filterByFocus,
  focusGroupsOf,
  focusSettingsOf,
  fullProjectOrder,
  listTitle,
  slotOrder,
  pinProjectIdForRow,
  resolveFocus,
  serverProjectsOf,
} from "./serverPins";

const PROJECTS = serverProjectsOf([
  { id: "pa", name: "alpha", handle: "alpha", path: "/a/", pinned: 1, tabOrder: 3, focusGroupId: "g1" },
  { id: "pb", name: "bravo", handle: "bravo", path: "/b", pinned: 0, tabOrder: 0, focusGroupId: null },
  { id: "pc", name: "charlie", handle: "charlie", path: "/c", pinned: true, tabOrder: 1, focusGroup: { id: "g2" } },
  { name: "no id", handle: "x", path: "/x" },
])!;

describe("serverPins", () => {
  it("reads projects/list (0|1) and projects-summary (bool, focusGroup) rows; drops rows without an id", () => {
    expect(PROJECTS.map((p) => [p.id, p.path, p.pinned, p.focusGroupId])).toEqual([
      ["pa", "/a", true, "g1"],
      ["pb", "/b", false, null],
      ["pc", "/c", true, "g2"],
    ]);
    expect(serverProjectsOf({ nope: 1 })).toBeNull();
  });

  it("pins map to main-chat rows by handle, then path; sidecars and groups never", () => {
    expect(pinProjectIdForRow({ id: "/a", addr: "alpha", path: "/a" }, PROJECTS)).toBe("pa");
    expect(pinProjectIdForRow({ id: "/b", addr: null, path: "/b" }, PROJECTS)).toBe("pb");
    expect(pinProjectIdForRow({ id: "s", addr: "alpha/1", path: "/a" }, PROJECTS)).toBeNull();
    expect(pinProjectIdForRow({ id: "g", kind: "group" }, PROJECTS)).toBeNull();
    expect(
      derivePinnedIds(
        [
          { id: "/a", addr: "alpha", path: "/a" },
          { id: "s", addr: "alpha/1", path: "/a" },
          { id: "/c", addr: "charlie", path: "/c" },
        ],
        PROJECTS
      )
    ).toEqual(["/c", "/a"]);
  });

  it("focus: literal true only; the title is the group name or Agents", () => {
    expect(focusSettingsOf({ focusGroupsEnabled: 1 }).enabled).toBe(false);
    const groups = focusGroupsOf({ groups: [{ id: "g1", name: "Work", color: "#f00" }] })!;
    const on = resolveFocus({ enabled: true, activeId: null }, groups);
    expect(listTitle(on)).toBe("Work");
    expect(listTitle(FOCUS_OFF)).toBe("Agents");
    expect(resolveFocus({ enabled: true, activeId: "g1" }, [])).toEqual(FOCUS_OFF);
  });

  it("filter keeps pinned, the current group and ungrouped; off keeps all", () => {
    const rows = [
      { id: "/a", addr: "alpha", path: "/a" },
      { id: "/b", addr: "bravo", path: "/b" },
      { id: "/c", addr: "charlie", path: "/c" },
      { id: "s", addr: "charlie/1", path: "/c" },
      { id: "g", kind: "group" as const },
    ];
    const focus = { enabled: true, currentId: "g1", groups: [{ id: "g1", name: "W", color: null }] };
    expect(filterByFocus(rows, focus, PROJECTS, []).map((r) => r.id)).toEqual(["/a", "/b", "g"]);
    expect(filterByFocus(rows, focus, PROJECTS, ["/c"]).map((r) => r.id)).toEqual(["/a", "/b", "/c", "g"]);
    expect(filterByFocus(rows, FOCUS_OFF, PROJECTS, [])).toHaveLength(5);
  });
});

describe("sortByProjectOrder (desktop's Agents order)", () => {
  const proj = (id: string, handle: string, tabOrder: number): ServerProject => ({
    id,
    name: handle,
    path: `/w/${handle}`,
    handle,
    pinned: false,
    tabOrder,
    focusGroupId: null,
  });
  const row = (addr: string) => ({ id: addr, addr, path: `/w/${addr}`, kind: "agent" as const });

  it("orders by tabOrder, then list position; unknown rows keep their order last", () => {
    const projects = [proj("p1", "b", 2), proj("p2", "a", 1), proj("p3", "c", 2)];
    const rows = [row("zz"), row("c"), row("b"), row("a"), row("yy")];
    expect(sortByProjectOrder(rows, projects, (r) => r).map((r) => r.addr)).toEqual([
      "a",
      "b",
      "c",
      "zz",
      "yy",
    ]);
  });
});

describe("Rearrange order (desktop's full projects/reorder)", () => {
  const P = (id: string, tabOrder: number, pinned = false): ServerProject => ({
    id,
    name: id,
    path: `/${id}`,
    handle: id,
    pinned,
    tabOrder,
    focusGroupId: null,
  });

  it("slotOrder: the subset takes its own slots, in its new order; the rest stay put", () => {
    expect(slotOrder(["a", "b", "c", "d"], ["d", "a", "c"])).toEqual(["d", "b", "a", "c"]);
    expect(slotOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    // Unknown and repeated ids are ignored.
    expect(slotOrder(["a", "b", "c"], ["c", "x", "a", "c"])).toEqual(["c", "b", "a"]);
  });

  it("fullProjectOrder: every project, pins and hidden rows keep their slots", () => {
    // Server: u1, p1 (pin), u2, p2 (pin), g (another focus group, not shown).
    const projects = [P("u1", 0), P("p1", 1, true), P("u2", 2), P("p2", 3, true), P("g", 4)];
    expect(fullProjectOrder(projects, [])).toEqual(["u1", "p1", "u2", "p2", "g"]);
    expect(fullProjectOrder(projects, ["u2", "u1"])).toEqual(["u2", "p1", "u1", "p2", "g"]);
  });

  it("fullProjectOrder: ties in tabOrder (a pinned-only reorder) resolve by list position, pins by their own order", () => {
    // Pins were reordered alone (tab_order 0, 1) and collide with unpinned rows.
    const projects = [P("u1", 0), P("u2", 1), P("p2", 0, true), P("p1", 1, true)];
    const full = fullProjectOrder(projects, []);
    expect(full).toHaveLength(4);
    expect(full.filter((id) => id.startsWith("p"))).toEqual(["p2", "p1"]);
    expect(full.filter((id) => id.startsWith("u"))).toEqual(["u1", "u2"]);
    expect(fullProjectOrder(projects, ["u2", "u1"]).filter((id) => id.startsWith("u"))).toEqual(["u2", "u1"]);
  });
});
