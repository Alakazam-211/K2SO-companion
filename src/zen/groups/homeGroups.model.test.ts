// @vitest-environment jsdom
// Home groups' data model (K2 0.46.13; brief companion-home-people-groups
// -brief-v1 §1, §2.1, §4): the wire fields, the merge rules for older
// parties, the store's group actions, the row order and the icon set.
import { beforeEach, describe, expect, it } from "vitest";
import { parseChangeItem, parsePullReply, toWireChange } from "../../api/homesSync";
import {
  applyRemote,
  changeKey,
  diffLocal,
  firstSyncMerge,
  type HomeChange,
  type MergeHome,
  type RowChange,
} from "../homesMerge";
import {
  DEFAULT_HOME_NAME,
  HOMES_STORAGE_KEY,
  emptyNameFallback,
  nextGroupName,
  parseHomesDoc,
  useHomesStore,
  type Home,
} from "../homes";
import { GROUP_ICONS, groupIcon, searchGroupIcons } from "./groupIcons";
import { MAX_PINS, displayRows, planRowDrop } from "./homeRowOrder";

// The brief's §1.3 list, in the grid's order: both apps offer the same picks.
const BRIEF_ICONS =
  "house building building-2 briefcase store factory warehouse landmark school hospital hotel tent castle church bot brain cpu server database hard-drive cloud monitor laptop smartphone tablet keyboard mouse terminal code code-xml braces git-branch git-merge git-pull-request bug wrench hammer cog sliders-horizontal puzzle package box boxes layers layout-grid layout-dashboard kanban list-todo list-checks clipboard-list calendar calendar-days clock alarm-clock timer hourglass inbox mail send message-square message-circle messages-square phone video mic headphones radio megaphone bell rss newspaper book book-open library notebook notebook-pen file-text files folder folder-open archive pencil pen-tool brush palette image camera film clapperboard music gamepad-2 dice-5 trophy medal award crown star heart thumbs-up smile sparkles zap flame rocket plane car bus train-front ship bike truck map map-pin compass globe earth mountain mountain-snow trees tree-pine leaf sprout flower sun moon cloud-sun snowflake umbrella waves droplet coffee cup-soda utensils pizza cake cookie carrot cherry citrus shopping-cart shopping-bag credit-card wallet banknote piggy-bank receipt chart-line chart-bar chart-pie trending-up activity gauge target flag bookmark tag tags hash at-sign link paperclip key lock shield shield-check eye search filter users user contact handshake baby dog cat bird fish rabbit paw-print bone dumbbell heart-pulse stethoscope pill graduation-cap lightbulb microscope flask-conical atom calculator ruler scale gavel anchor life-buoy circle-help info triangle-alert circle square triangle hexagon diamond gem shapes infinity recycle battery-full plug power wifi satellite telescope orbit ghost swords wand-sparkles glasses shirt footprints gift party-popper bed sofa lamp armchair pin tractor construction ticket tv podcast languages binary workflow network share-2 route signpost milestone container blocks flower-2 pen-line".split(
    " "
  );

describe("the icon set", () => {
  it("is exactly the brief's 244 Lucide names, in the grid's order, each drawable", () => {
    expect(GROUP_ICONS.map((d) => d.name)).toEqual(BRIEF_ICONS);
    expect(GROUP_ICONS).toHaveLength(244);
    for (const d of GROUP_ICONS) expect(typeof d.Icon === "function" || typeof d.Icon === "object").toBe(true);
  });

  it("an unknown or empty name has no icon (the number draws)", () => {
    expect(groupIcon("rocket")?.name).toBe("rocket");
    expect(groupIcon("not-an-icon")).toBeNull();
    expect(groupIcon(null)).toBeNull();
  });

  it("search matches the start of every word against the name's parts and keywords", () => {
    expect(searchGroupIcons("")).toHaveLength(244);
    expect(searchGroupIcons("git").map((d) => d.name)).toEqual(["git-branch", "git-merge", "git-pull-request"]);
    expect(searchGroupIcons("pull req").map((d) => d.name)).toEqual(["git-pull-request"]);
    expect(searchGroupIcons("ai").map((d) => d.name)).toEqual(expect.arrayContaining(["bot", "brain"]));
  });
});

describe("the wire (K2 0.46.13 fields)", () => {
  it("reads icon / recentFirst on a Home and pinOrder / lastMessagedAt on rows of every kind", () => {
    expect(parseChangeItem({ kind: "home", id: "g", name: "Studio", icon: "rocket", recentFirst: true, order: "V", updatedAt: 1 })).toMatchObject({
      icon: "rocket",
      recentFirst: true,
    });
    expect(parseChangeItem({ kind: "home", id: "g", name: "S", icon: null, order: "V", updatedAt: 1 })).toMatchObject({ icon: null });
    // Not storable: left out (doesn't say), never a broken value.
    expect(parseChangeItem({ kind: "home", id: "g", name: "S", icon: "Bad Name!", order: "V", updatedAt: 1 })).not.toHaveProperty("icon");
    // An older server: no fields at all.
    const old = parseChangeItem({ kind: "home", id: "g", name: "S", order: "V", updatedAt: 1 })!;
    expect(old).not.toHaveProperty("icon");
    expect(old).not.toHaveProperty("recentFirst");
    for (const kind of ["row", "person", "channel"]) {
      expect(
        parseChangeItem({ kind, homeId: "g", address: "x::s", label: "X", order: "V", pinOrder: "a", lastMessagedAt: 5, updatedAt: 1 })
      ).toMatchObject({ kind, pinOrder: "a", lastMessagedAt: 5 });
    }
    expect(parseChangeItem({ kind: "row", homeId: "g", address: "x::s", label: "X", order: "V", pinOrder: null, updatedAt: 1 })).toMatchObject({
      pinOrder: null,
    });
    // A kind this build doesn't know is dropped (never drawn, never tombstoned).
    expect(parseChangeItem({ kind: "garden", homeId: "g", address: "x::s", order: "V", updatedAt: 1 })).toBeNull();
  });

  it("writes a group field only when the change says it", () => {
    const h: HomeChange = { kind: "home", id: "g", name: "S", order: "V", updatedAt: 1 };
    expect(toWireChange(h)).not.toHaveProperty("icon");
    expect(toWireChange({ ...h, icon: null, recentFirst: false })).toMatchObject({ icon: null, recentFirst: false });
    const r: RowChange = { kind: "person", homeId: "g", address: "k2:owner::s", label: "R", workspaceId: null, order: "V", updatedAt: 1 };
    expect(toWireChange(r)).toEqual({ kind: "person", homeId: "g", address: "k2:owner::s", label: "R", workspaceId: null, order: "V", updatedAt: 1 });
    expect(toWireChange({ ...r, pinOrder: "V", lastMessagedAt: 9 })).toMatchObject({ pinOrder: "V", lastMessagedAt: 9 });
    // A tombstone carries none of them.
    expect(toWireChange({ ...r, pinOrder: "V", deleted: true })).not.toHaveProperty("pinOrder");
  });

  it("the pull's kinds: listed by 0.46.13, home/row for an older server", () => {
    expect(parsePullReply({ cursor: 1, changes: [], kinds: ["home", "row", "person", "channel"] })).toMatchObject({
      kinds: ["home", "row", "person", "channel"],
      groups: true,
    });
    expect(parsePullReply({ cursor: 1, changes: [] })).toMatchObject({ kinds: ["home", "row"], groups: false });
  });

  it("an agent row and a channel row on the same address are two items", () => {
    const a: RowChange = { kind: "row", homeId: "g", address: "42::s", label: "", workspaceId: null, order: "V", updatedAt: 1 };
    expect(changeKey(a)).toBe("r|g|42::s");
    expect(changeKey({ ...a, kind: "channel" })).toBe("c|g|42::s");
    expect(changeKey({ ...a, kind: "person" })).toBe("p|g|42::s");
    expect(changeKey({ kind: "row", rowKind: "channel", homeId: "g", address: "42::s", updatedAt: 1 })).toBe("c|g|42::s");
  });
});

describe("merge rules for older parties", () => {
  const known: MergeHome = {
    id: "g",
    name: "Studio",
    order: "V",
    updatedAt: 10,
    by: "a",
    icon: "rocket",
    recentFirst: true,
    rows: [{ address: "atlas::s", label: "Atlas", workspaceId: null, order: "V", updatedAt: 10, by: "a", pinOrder: "V", lastMessagedAt: 500 }],
  };
  const st = { homes: [known], tombstones: [], redirects: {} };

  it("a newer pulled item that leaves the fields out keeps what the phone knows", () => {
    const res = applyRemote(st, [
      { kind: "home", id: "g", name: "Studio 2", order: "V", updatedAt: 20, by: "b" },
      { kind: "row", homeId: "g", address: "atlas::s", label: "Atlas", workspaceId: null, order: "k", updatedAt: 20, by: "b" },
    ]);
    expect(res.state.homes[0]).toMatchObject({ name: "Studio 2", icon: "rocket", recentFirst: true });
    expect(res.state.homes[0].rows[0]).toMatchObject({ order: "k", pinOrder: "V", lastMessagedAt: 500 });
  });

  it("null / false clears; the last send never moves back", () => {
    const res = applyRemote(st, [
      { kind: "home", id: "g", name: "Studio", order: "V", updatedAt: 20, by: "b", icon: null, recentFirst: false },
      { kind: "row", homeId: "g", address: "atlas::s", label: "Atlas", workspaceId: null, order: "V", updatedAt: 20, by: "b", pinOrder: null, lastMessagedAt: 100 },
    ]);
    expect(res.state.homes[0].icon).toBeUndefined();
    expect(res.state.homes[0].recentFirst).toBeUndefined();
    expect(res.state.homes[0].rows[0].pinOrder).toBeUndefined();
    expect(res.state.homes[0].rows[0].lastMessagedAt).toBe(500);
  });

  it("a local edit says a clear (null) but leaves out a field it didn't touch", () => {
    const cleared = { ...known, rows: known.rows.map((r) => ({ ...r })) };
    delete cleared.icon;
    const d = diffLocal([known], [cleared], { now: 100, by: "me" });
    expect(d.changes).toEqual([expect.objectContaining({ kind: "home", icon: null, recentFirst: true })]);
    const renamed = diffLocal([known], [{ ...known, name: "New", icon: undefined }].map((h) => {
      const c = { ...h };
      delete c.icon;
      return c;
    }), { now: 100, by: "me" });
    expect(renamed.changes[0]).toMatchObject({ icon: null });
    // A plain rename of a Home with no icon never sends icon: null.
    const plain: MergeHome = { id: "p", name: "P", order: "V", updatedAt: 1, rows: [] };
    expect(diffLocal([plain], [{ ...plain, name: "Q" }], { now: 100, by: "me" }).changes[0]).not.toHaveProperty("icon");
  });

  it("an Undo (the same id back) beats its tombstone, rows included", () => {
    const del = diffLocal([known], [], { now: 1000, by: "me" });
    expect(del.changes.map((c) => c.deleted)).toEqual([true, true]);
    const back = diffLocal([], [known], { now: 1000, by: "me", tombstones: del.tombstones });
    for (const c of back.changes) expect(c.updatedAt).toBeGreaterThan(1000);
    expect(back.changes.map((c) => c.kind)).toEqual(["home", "row"]);
    expect(back.changes[0]).toMatchObject({ id: "g", icon: "rocket", recentFirst: true });
    expect(back.changes[1]).toMatchObject({ pinOrder: "V", lastMessagedAt: 500 });
  });

  it("first sync: an untouched 'Group 1' seed merges into an untouched 'Home' seed", () => {
    const local = { homes: [{ id: "phone-seed", name: "Group 1", rows: [] } as MergeHome], tombstones: [], redirects: {} };
    const res = firstSyncMerge(local, [{ kind: "home", id: "desk-seed", name: "Home", order: "V", updatedAt: 5, by: "desk" }], {
      now: 100,
      by: "me",
    });
    expect(res.state.homes.map((h) => h.id)).toEqual(["desk-seed"]);
    expect(res.state.redirects).toEqual({ "phone-seed": "desk-seed" });
  });

  it("first sync: a merged group keeps the server's pins; a local icon fills a server group without one", () => {
    const local = {
      homes: [
        {
          id: "mine",
          name: "Studio",
          icon: "rocket",
          updatedAt: 1,
          rows: [{ address: "forge::s", label: "Forge", workspaceId: null, pinOrder: "V", updatedAt: 1 }],
        } as MergeHome,
      ],
      tombstones: [],
      redirects: {},
    };
    const res = firstSyncMerge(local, [{ kind: "home", id: "srv", name: "Studio", order: "V", updatedAt: 5, by: "desk" }], {
      now: 100,
      by: "me",
    });
    expect(res.state.homes[0]).toMatchObject({ id: "srv", icon: "rocket" });
    expect(res.state.homes[0].rows[0].pinOrder).toBeUndefined();
    expect(res.changes.find((c) => c.kind === "home")).toMatchObject({ id: "srv", icon: "rocket" });
  });
});

describe("the store's group actions", () => {
  beforeEach(() => {
    localStorage.clear();
    useHomesStore.getState().reload();
    useHomesStore.getState().ensureSeeded();
  });
  const st = () => useHomesStore.getState();
  const stored = () => parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY));

  it("names: 'Group N' defaults, an emptied name saves as the next one, 60 chars, duplicates allowed", () => {
    expect(DEFAULT_HOME_NAME).toBe("Group 1");
    expect(st().homes[0].name).toBe("Group 1");
    expect(nextGroupName([{ name: "Group 1" }, { name: " group 2 " }])).toBe("Group 3");
    const id2 = st().createGroup();
    expect(st().selectedId).toBe(id2);
    expect(st().homes.map((h) => h.name)).toEqual(["Group 1", "Group 2"]);
    expect(st().renameGroup(id2, "   ")).toBe("saved");
    expect(st().homes[1].name).toBe("Group 2");
    expect(emptyNameFallback(st().homes, id2)).toBe("Group 2");
    expect(st().renameGroup(id2, "Group 1")).toBe("saved");
    expect(st().homes.map((h) => h.name)).toEqual(["Group 1", "Group 1"]);
    expect(st().renameGroup(id2, "x".repeat(80))).toBe("saved");
    expect(st().homes[1].name).toHaveLength(60);
    expect(st().renameGroup("gone", "A")).toBe("refused");
  });

  it("a failed save reports unsaved (the sheet keeps the text and offers Try again)", () => {
    const id = st().selectedId;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === HOMES_STORAGE_KEY) throw new Error("quota");
      return orig.call(this, k, v);
    };
    try {
      expect(st().renameGroup(id, "Studio")).toBe("unsaved");
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("icon by name (storable names only), Most recent at the top, reorder", () => {
    const id = st().selectedId;
    expect(st().setHomeIcon(id, "rocket")).toBe(true);
    expect(st().setHomeIcon(id, "Not Valid")).toBe(false);
    expect(stored()?.homes[0].icon).toBe("rocket");
    expect(st().setHomeIcon(id, null)).toBe(true);
    expect(stored()?.homes[0].icon).toBeUndefined();
    expect(st().setRecentFirst(id, true)).toBe(true);
    expect(stored()?.homes[0].recentFirst).toBe(true);
    const b = st().createGroup();
    expect(st().reorderHomes([b, id])).toBe(true);
    expect(st().homes.map((h) => h.id)).toEqual([b, id]);
    expect(st().reorderHomes([b])).toBe(false);
  });

  it("delete, then Undo with the same id, place, rows, pins and icon; the last group stays", () => {
    const first = st().selectedId;
    const b = st().createGroup();
    st().setHomeIcon(b, "rocket");
    st().addRow(b, { address: "atlas::s", workspaceId: null, label: "Atlas" });
    st().pinRow(b, "atlas::s");
    st().createGroup();
    st().selectHome(b);
    const kept = st().homes.find((h) => h.id === b) as Home;
    expect(st().deleteHome(b)).toBe(true);
    expect(st().selectedId).toBe(first);
    expect(st().tombstones.map((t) => (t.kind === "home" ? t.id : t.address))).toEqual(expect.arrayContaining([b, "atlas::s"]));
    expect(st().restoreHome(kept, 1)).toBe(true);
    expect(st().homes[1]).toMatchObject({ id: b, icon: "rocket", rows: [expect.objectContaining({ address: "atlas::s", pinOrder: expect.any(String) })] });
    expect(st().restoreHome(kept, 1)).toBe(false);
    expect(st().tombstones.some((t) => t.kind === "home" && t.id === b)).toBe(false);
    for (const h of st().homes.slice(1)) st().deleteHome(h.id);
    expect(st().deleteHome(st().homes[0].id)).toBe(false);
  });

  it("pins: at most 9 per group across every row kind, pinned first in pin order", () => {
    const id = st().selectedId;
    for (let i = 0; i < 8; i++) st().addRow(id, { address: `a${i}::s`, workspaceId: null, label: `A${i}` });
    st().addRow(id, { kind: "person", address: "k2:owner::s", workspaceId: null, label: "Owner" });
    st().addRow(id, { kind: "channel", address: "77::s", workspaceId: null, label: "general" });
    for (let i = 7; i >= 0; i--) expect(st().pinRow(id, `a${i}::s`)).toBe("pinned");
    expect(st().pinRow(id, "k2:owner::s")).toBe("pinned");
    expect(st().pinRow(id, "77::s")).toBe("full");
    expect(st().homes[0].rows.filter((r) => r.pinOrder)).toHaveLength(MAX_PINS);
    expect(st().pinRow(id, "a0::s")).toBe("already");
    const shown = displayRows(st().homes[0]).map((r) => r.address);
    expect(shown.slice(0, 3)).toEqual(["a7::s", "a6::s", "a5::s"]);
    expect(shown[9]).toBe("77::s");
    expect(st().unpinRow(id, "a7::s")).toBe(true);
    expect(st().pinRow(id, "77::s")).toBe("pinned");
  });

  it("a person row must name a person, a channel row a channel id", () => {
    const id = st().selectedId;
    expect(st().addRow(id, { kind: "person", address: "k2:workspace:x::s", workspaceId: null, label: "x" })).toBe(false);
    expect(st().addRow(id, { kind: "channel", address: "general::s", workspaceId: null, label: "x" })).toBe(false);
    expect(st().addRow(id, { kind: "person", address: "k2:connect:ab-12::s", workspaceId: null, label: "x" })).toBe(true);
  });

  it("the last-send stamp only moves forward; Most recent at the top orders unpinned rows by it", () => {
    const id = st().selectedId;
    for (const a of ["a", "b", "c"]) st().addRow(id, { address: `${a}::s`, workspaceId: null, label: a });
    expect(st().stampRowsMessaged((r) => r.address === "b::s", 200)).toBe(1);
    expect(st().stampRowsMessaged((r) => r.address === "b::s", 100)).toBe(0);
    st().stampRowsMessaged((r) => r.address === "c::s", 300);
    expect(displayRows(st().homes[0]).map((r) => r.address)).toEqual(["a::s", "b::s", "c::s"]);
    st().setRecentFirst(id, true);
    expect(displayRows(st().homes[0]).map((r) => r.address)).toEqual(["c::s", "b::s", "a::s"]);
  });

  it("a drop moves pins among pins and others among others; none with Most recent at the top", () => {
    const home = {
      rows: [
        { address: "a" },
        { address: "p1", pinOrder: "V" },
        { address: "b" },
        { address: "p2", pinOrder: "k" },
        { address: "c" },
      ],
    };
    // Shown: p1 p2 a b c
    expect(planRowDrop(home, 1, 0)).toEqual({ pins: ["p2", "p1"] });
    expect(planRowDrop(home, 4, 2)).toEqual({ rows: ["c", "p1", "a", "p2", "b"] });
    expect(planRowDrop({ ...home, recentFirst: true }, 4, 2)).toBeNull();
  });
});
