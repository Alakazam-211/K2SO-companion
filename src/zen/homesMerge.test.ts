import { describe, expect, it } from "vitest";
import {
  TOMBSTONE_MAX_AGE_MS,
  applyRemote,
  coalesceOutbox,
  compareStamp,
  diffLocal,
  firstSyncMerge,
  incomingWins,
  markSyncedKeys,
  migrateHomeAddresses,
  pruneTombstones,
  reconcileFull,
  redirectOutbox,
  resolveHomeId,
  settleOutbox,
  type ChangeItem,
  type HomeChange,
  type MergeHome,
  type RowChange,
  type SyncState,
} from "./homesMerge";

const ME = "dev-b";
const OTHER = "dev-a";

function row(address: string, extra: Partial<RowChange> = {}) {
  return { address, workspaceId: null, label: address.split("::")[0], ...extra };
}

function home(id: string, name: string, rows: MergeHome["rows"] = [], extra: Partial<MergeHome> = {}): MergeHome {
  return { id, name, rows, ...extra };
}

function hc(id: string, name: string, order: string, updatedAt: number, extra: Partial<HomeChange> = {}): HomeChange {
  return { kind: "home", id, name, order, updatedAt, by: OTHER, ...extra };
}

function rc(homeId: string, address: string, order: string, updatedAt: number, extra: Partial<RowChange> = {}): RowChange {
  return {
    kind: "row",
    homeId,
    address,
    label: address.split("::")[0],
    workspaceId: null,
    order,
    updatedAt,
    by: OTHER,
    ...extra,
  };
}

function state(homes: MergeHome[], extra: Partial<SyncState> = {}): SyncState {
  return { homes, tombstones: [], redirects: {}, ...extra };
}

describe("LWW stamps", () => {
  it("later updatedAt wins; an exact tie goes to the larger device id", () => {
    expect(compareStamp({ updatedAt: 2 }, { updatedAt: 1 })).toBeGreaterThan(0);
    expect(compareStamp({ updatedAt: 1, by: "b" }, { updatedAt: 1, by: "a" })).toBeGreaterThan(0);
    expect(compareStamp({ updatedAt: 1, by: "a" }, { updatedAt: 1, by: "b" })).toBeLessThan(0);
    expect(compareStamp({ updatedAt: 1, by: "a" }, { updatedAt: 1, by: "a" })).toBe(0);
    // Missing stamps (rows saved before sync) read as 0.
    expect(compareStamp({}, { updatedAt: 1 })).toBeLessThan(0);
  });

  it("a tombstone beats an older edit and wins an exact tie", () => {
    expect(incomingWins({ updatedAt: 5, deleted: true }, { updatedAt: 4 })).toBe(true);
    expect(incomingWins({ updatedAt: 5, deleted: true, by: "x" }, { updatedAt: 5, by: "x" })).toBe(true);
    expect(incomingWins({ updatedAt: 5, by: "x" }, { updatedAt: 5, by: "x", deleted: true })).toBe(false);
    expect(incomingWins({ updatedAt: 4 }, { updatedAt: 5, deleted: true })).toBe(false);
  });
});

describe("diffLocal (every local edit is stamped and queued)", () => {
  const prev = [home("h1", "Home", [row("a::s"), row("b::s")])];
  const keyed = diffLocal([], prev, { now: 1, by: ME }).homes;

  it("a new Home and its rows are stamped and get order keys", () => {
    const d = diffLocal([], prev, { now: 1000, by: ME });
    expect(d.homes[0]).toMatchObject({ updatedAt: 1000, by: ME, order: "V" });
    expect(d.homes[0].rows.map((r) => r.order)).toEqual(["V", "l"]);
    expect(d.changes.map((c) => c.kind)).toEqual(["home", "row", "row"]);
  });

  it("rename stamps only the Home", () => {
    const next = [{ ...keyed[0], name: "Work" }];
    const d = diffLocal(keyed, next, { now: 2000, by: ME });
    expect(d.changes).toEqual([expect.objectContaining({ kind: "home", id: "h1", name: "Work", updatedAt: 2000, by: ME })]);
  });

  it("a remove leaves a tombstone and a delete change", () => {
    const next = [{ ...keyed[0], rows: [keyed[0].rows[1]] }];
    const d = diffLocal(keyed, next, { now: 3000, by: ME });
    expect(d.tombstones).toEqual([{ kind: "row", homeId: "h1", address: "a::s", updatedAt: 3000, by: ME }]);
    expect(d.changes).toEqual([expect.objectContaining({ kind: "row", address: "a::s", deleted: true })]);
  });

  it("a reorder re-keys only the moved row", () => {
    const next = [{ ...keyed[0], rows: [keyed[0].rows[1], keyed[0].rows[0]] }];
    const d = diffLocal(keyed, next, { now: 4000, by: ME });
    expect(d.changes).toHaveLength(1);
    expect(d.homes[0].rows.map((r) => r.address)).toEqual(["b::s", "a::s"]);
    expect(d.homes[0].rows[0].order! < d.homes[0].rows[1].order!).toBe(true);
  });

  it("deleting a Home tombstones it", () => {
    const d = diffLocal(keyed, [], { now: 5000, by: ME });
    expect(d.changes).toEqual([expect.objectContaining({ kind: "home", id: "h1", deleted: true, updatedAt: 5000 })]);
  });
});

describe("applyRemote (steady state)", () => {
  // A phone that has synced: the server has seen both items.
  const local = state([
    home("h1", "Home", [{ ...row("a::s", { order: "V", updatedAt: 10 }), synced: true }], { order: "V", updatedAt: 10, synced: true }),
  ]);

  it("newer remote edits win; older ones lose", () => {
    const r1 = applyRemote(local, [hc("h1", "Office", "V", 20)]);
    expect(r1.state.homes[0].name).toBe("Office");
    const r2 = applyRemote(local, [hc("h1", "Old", "V", 5)]);
    expect(r2.changed).toBe(false);
    expect(r2.state.homes[0].name).toBe("Home");
  });

  it("ties break by device id", () => {
    const tied = state([home("h1", "Mine", [], { order: "V", updatedAt: 10, by: "m" })]);
    expect(applyRemote(tied, [hc("h1", "Theirs", "V", 10, { by: "z" })]).state.homes[0].name).toBe("Theirs");
    expect(applyRemote(tied, [hc("h1", "Theirs", "V", 10, { by: "a" })]).state.homes[0].name).toBe("Mine");
  });

  it("a remote tombstone beats an older edit; an older tombstone does not", () => {
    const del = applyRemote(local, [rc("h1", "a::s", "", 11, { deleted: true })]);
    expect(del.state.homes[0].rows).toEqual([]);
    expect(del.state.tombstones).toEqual([expect.objectContaining({ kind: "row", address: "a::s", updatedAt: 11 })]);
    const stale = applyRemote(local, [rc("h1", "a::s", "", 9, { deleted: true })]);
    expect(stale.changed).toBe(false);
  });

  it("a local tombstone blocks an older remote re-add, not a newer one", () => {
    const withTomb = state([home("h1", "Home", [], { order: "V", updatedAt: 10 })], {
      tombstones: [{ kind: "row", homeId: "h1", address: "a::s", updatedAt: 50 }],
    });
    expect(applyRemote(withTomb, [rc("h1", "a::s", "V", 40)]).changed).toBe(false);
    const back = applyRemote(withTomb, [rc("h1", "a::s", "V", 60)]);
    expect(back.state.homes[0].rows.map((r) => r.address)).toEqual(["a::s"]);
    expect(back.state.tombstones).toEqual([]);
  });

  it("a deleted Home drops; a new Home is added and sorted by order", () => {
    const two = applyRemote(local, [hc("h0", "First", "G", 5), rc("h0", "x::s", "V", 5)]);
    expect(two.state.homes.map((h) => h.id)).toEqual(["h0", "h1"]);
    expect(two.state.homes[0].rows.map((r) => r.address)).toEqual(["x::s"]);
    const gone = applyRemote(two.state, [hc("h0", "", "", 6, { deleted: true })]);
    expect(gone.state.homes.map((h) => h.id)).toEqual(["h1"]);
  });

  it("concurrent reorders converge on one order on every device", () => {
    const base = state([
      home("h1", "Home", [
        row("a::s", { order: "V", updatedAt: 1 }),
        row("b::s", { order: "l", updatedAt: 1 }),
        row("c::s", { order: "t", updatedAt: 1 }),
      ], { order: "V", updatedAt: 1 }),
    ]);
    // Device A moves c to the top; device B moves a to the bottom.
    const fromA = rc("h1", "c::s", "G", 100, { by: "dev-a" });
    const fromB = rc("h1", "a::s", "x", 101, { by: "dev-b" });
    const onA = applyRemote(applyRemote(base, [fromA]).state, [fromB]).state;
    const onB = applyRemote(applyRemote(base, [fromB]).state, [fromA]).state;
    const order = (s: SyncState) => s.homes[0].rows.map((r) => r.address);
    expect(order(onA)).toEqual(["c::s", "b::s", "a::s"]);
    expect(order(onB)).toEqual(order(onA));
  });

  it("rows for an unknown Home are orphans (full re-pull); for a deleted Home, ignored", () => {
    expect(applyRemote(local, [rc("hX", "q::s", "V", 5)]).orphans).toBe(1);
    const tomb = state([], { tombstones: [{ kind: "home", id: "hX", updatedAt: 9 }] });
    expect(applyRemote(tomb, [rc("hX", "q::s", "V", 5)]).orphans).toBe(0);
  });

  it("follows first-sync redirects", () => {
    const red = state(local.homes.map((h) => ({ ...h, id: "srv" })), { redirects: { h1: "srv" } });
    expect(resolveHomeId(red.redirects, "h1")).toBe("srv");
    expect(applyRemote(red, [rc("h1", "z::s", "l", 20)]).state.homes[0].rows.map((r) => r.address)).toEqual(["a::s", "z::s"]);
  });

  it("our own echo changes nothing", () => {
    const echo = applyRemote(local, [{ ...rc("h1", "a::s", "V", 10), by: undefined }]);
    expect(echo.changed).toBe(false);
  });
});

describe("first sync: union, never delete", () => {
  const local = state([
    home("loc-home", "Home", [row("a::s"), row("b::s")]),
    home("loc-lab", "Lab", [row("l::s")]),
  ]);

  it("same-name Homes merge into the server's id with a redirect; rows union local-first", () => {
    const remote: ChangeItem[] = [
      hc("srv-home", "home", "V", 50),
      rc("srv-home", "b::s", "V", 50, { label: "B from desktop" }),
      rc("srv-home", "c::s", "l", 50),
      hc("srv-work", "Work", "l", 50),
      rc("srv-work", "w::s", "V", 50),
    ];
    const r = firstSyncMerge(local, remote, { now: 1000, by: ME });
    expect(r.state.redirects).toEqual({ "loc-home": "srv-home" });
    expect(r.state.homes.map((h) => [h.id, h.name])).toEqual([
      ["srv-home", "home"],
      ["loc-lab", "Lab"],
      ["srv-work", "Work"],
    ]);
    // Local rows first in local order, then the server's other rows.
    expect(r.state.homes[0].rows.map((x) => x.address)).toEqual(["a::s", "b::s", "c::s"]);
    // A row both hold: the newer write (the server's, local had no stamp).
    expect(r.state.homes[0].rows[1].label).toBe("B from desktop");
    // Orders follow the merged list.
    const orders = r.state.homes.map((h) => h.order!);
    expect([...orders].sort()).toEqual(orders);
    // Nothing deleted, nothing dropped.
    expect(r.changes.some((c) => c.deleted)).toBe(false);
    // The server hears the local-only Home and rows.
    const keys = r.changes.map((c) => (c.kind === "home" ? `h:${c.id}` : `r:${c.homeId}:${c.address}`));
    expect(keys).toEqual(expect.arrayContaining(["h:loc-lab", "r:loc-lab:l::s", "r:srv-home:a::s"]));
    expect(keys).not.toContain("r:srv-work:w::s");
  });

  it("a local item the server tombstoned is kept and re-stamped so it survives", () => {
    const keyedLocal = state([home("h1", "Home", [row("a::s", { updatedAt: 5, order: "V" })], { updatedAt: 5, order: "V" })]);
    const remote: ChangeItem[] = [hc("h1", "Home", "V", 5), rc("h1", "a::s", "", 9, { deleted: true })];
    const r = firstSyncMerge(keyedLocal, remote, { now: 1000, by: ME });
    expect(r.state.homes[0].rows.map((x) => x.address)).toEqual(["a::s"]);
    expect(r.changes).toEqual([expect.objectContaining({ kind: "row", address: "a::s", updatedAt: 1000, by: ME })]);
  });

  it("an empty server gets everything; an empty phone gets the server's", () => {
    const up = firstSyncMerge(local, [], { now: 1, by: ME });
    expect(up.state.homes.map((h) => h.id)).toEqual(["loc-home", "loc-lab"]);
    expect(up.changes.filter((c) => c.kind === "row")).toHaveLength(3);
    const down = firstSyncMerge(state([]), [hc("s1", "Home", "V", 1), rc("s1", "a::s", "V", 1)], { now: 2, by: ME });
    expect(down.state.homes.map((h) => h.id)).toEqual(["s1"]);
    expect(down.changes).toEqual([]);
  });
});

describe("outbox + tombstones", () => {
  it("coalesces by key (latest write) and settles what was sent or rejected", () => {
    const a1 = rc("h", "a::s", "V", 1);
    const a2 = rc("h", "a::s", "V", 2);
    const b = rc("h", "b::s", "l", 1);
    const box = coalesceOutbox([a1, b], [a2]);
    expect(box).toEqual([a2, b]);
    // Sent a1, but a2 was written since: a2 stays.
    expect(settleOutbox(box, [a1])).toEqual([a2, b]);
    expect(settleOutbox(box, [a2])).toEqual([b]);
    expect(settleOutbox(box, [], ["r|h|b::s"])).toEqual([a2]);
  });

  it("prunes tombstones older than 90 days", () => {
    const now = 100 * 24 * 3600_000;
    const old = { kind: "home" as const, id: "x", updatedAt: now - TOMBSTONE_MAX_AGE_MS - 1 };
    const young = { kind: "home" as const, id: "y", updatedAt: now - 1000 };
    expect(pruneTombstones([old, young], now)).toEqual([young]);
  });
});

describe("hostKey → box id migration", () => {
  it("rewrites addresses, dedupes per Home, null when nothing changes", () => {
    const canon = (a: string) => a.replace("::rosson.k2.dev", "::0123456789abcdef");
    const homes = [home("h", "Home", [row("a::rosson.k2.dev"), row("a::0123456789abcdef"), row("b::other")])];
    const out = migrateHomeAddresses(homes, canon)!;
    expect(out[0].rows.map((r) => r.address)).toEqual(["a::0123456789abcdef", "b::other"]);
    expect(migrateHomeAddresses(out, canon)).toBeNull();
  });
});

describe("K2 0.46.1 final contract", () => {
  const DAY = 24 * 3600_000;

  it("tombstones are kept 90 days (not 30); a mergedInto Home tombstone is kept for good", () => {
    const now = 400 * DAY;
    const d31 = { kind: "row" as const, homeId: "h", address: "a::s", updatedAt: now - 31 * DAY };
    const d89 = { kind: "home" as const, id: "y", updatedAt: now - 89 * DAY };
    const d91 = { kind: "home" as const, id: "z", updatedAt: now - 91 * DAY };
    const merged = { kind: "home" as const, id: "m", updatedAt: now - 300 * DAY, mergedInto: "h" };
    expect(TOMBSTONE_MAX_AGE_MS).toBe(90 * DAY);
    expect(pruneTombstones([d31, d89, d91, merged], now)).toEqual([d31, d89, merged]);
  });

  it("tie-break: same updatedAt → the larger deviceId wins; a full tie → the tombstone", () => {
    const mine = state([
      home("h1", "Mine", [{ ...row("a::s", { order: "V", updatedAt: 10, by: "phone-1" }), synced: true }], {
        order: "V",
        updatedAt: 10,
        by: "phone-1",
        synced: true,
      }),
    ]);
    // `desk-1` < `phone-1`: the phone's version stands.
    expect(applyRemote(mine, [hc("h1", "Desk", "V", 10, { by: "desk-1" })]).changed).toBe(false);
    // `zz-tablet` > `phone-1`: the tablet wins.
    expect(applyRemote(mine, [hc("h1", "Tab", "V", 10, { by: "zz-tablet" })]).state.homes[0].name).toBe("Tab");
    // Same stamp and device: the tombstone wins.
    const tomb = rc("h1", "a::s", "V", 10, { by: "phone-1", deleted: true });
    expect(applyRemote(mine, [tomb]).state.homes[0].rows).toEqual([]);
  });

  it("a full answer is merged per item: local items it lacks stay; only tombstones delete", () => {
    const local = state([
      home("h1", "Home", [row("a::s", { order: "V", updatedAt: 10 }), row("mine::s", { order: "l", updatedAt: 10 })], { order: "V", updatedAt: 10 }),
      home("h2", "Local only", [], { order: "l", updatedAt: 10 }),
    ]);
    const full: ChangeItem[] = [hc("h1", "Home", "V", 10), rc("h1", "a::s", "V", 20, { deleted: true }), rc("h1", "srv::s", "t", 20)];
    const r = applyRemote(local, full);
    expect(r.state.homes.map((h) => [h.id, h.rows.map((x) => x.address)])).toEqual([
      ["h1", ["mine::s", "srv::s"]],
      ["h2", []],
    ]);
  });

  it("pull redirects: a local Home under an old id folds into the new one; ids are recorded", () => {
    const local = state([
      home("h-old", "Home", [row("a::s", { order: "V", updatedAt: 5 }), row("b::s", { order: "l", updatedAt: 5 })], { order: "V", updatedAt: 5 }),
      home("h1", "Home", [row("b::s", { order: "V", updatedAt: 9, label: "kept" })], { order: "l", updatedAt: 9 }),
    ]);
    const r = applyRemote(local, [], { redirects: { "h-old": "h1" } });
    expect(r.changed).toBe(true);
    expect(r.state.redirects).toEqual({ "h-old": "h1" });
    expect(r.state.homes.map((h) => h.id)).toEqual(["h1"]);
    // h1's own copy of b::s stays; a::s moved over (sorted by order key).
    expect(r.state.homes[0].rows.map((x) => [x.address, x.label])).toEqual([
      ["a::s", "a"],
      ["b::s", "kept"],
    ]);
    expect(resolveHomeId(r.state.redirects, "h-old")).toBe("h1");
    // The moved row is handed back to be queued under h1 (stamps kept).
    expect(r.moved).toEqual([expect.objectContaining({ kind: "row", homeId: "h1", address: "a::s", updatedAt: 5 })]);
    // Not here yet: the old Home takes the new id, unstamped (the server's
    // version of h1 then wins).
    const alone = applyRemote(state([home("h-old", "Mine", [row("a::s")], { order: "V", updatedAt: 5 })]), [], {
      redirects: { "h-old": "h1" },
    });
    expect(alone.state.homes).toEqual([expect.objectContaining({ id: "h1", name: "Mine", updatedAt: 0 })]);
    const thenServer = applyRemote(alone.state, [hc("h1", "Home", "V", 1)]);
    expect(thenServer.state.homes[0].name).toBe("Home");
  });

  it("a Home tombstone with mergedInto moves the rows there and records a redirect", () => {
    const local = state([
      home("h-old", "Old", [row("a::s", { order: "V", updatedAt: 5 })], { order: "V", updatedAt: 5 }),
      home("h1", "Home", [], { order: "l", updatedAt: 5 }),
    ]);
    const r = applyRemote(local, [hc("h-old", "", "", 50, { deleted: true, mergedInto: "h1" })]);
    expect(r.state.homes.map((h) => [h.id, h.rows.map((x) => x.address)])).toEqual([["h1", ["a::s"]]]);
    expect(r.state.redirects).toEqual({ "h-old": "h1" });
    expect(r.state.tombstones).toEqual([expect.objectContaining({ kind: "home", id: "h-old", mergedInto: "h1" })]);
    // Seen again (a full pull), the tombstone never deletes h1.
    const again = applyRemote(r.state, [hc("h-old", "", "", 50, { deleted: true, mergedInto: "h1" })]);
    expect(again.state.homes.map((h) => h.id)).toEqual(["h1"]);
    // A row tombstone for the old Home does not delete the moved row; a
    // live row for the old Home lands on the new one.
    const rows = applyRemote(r.state, [rc("h-old", "a::s", "V", 60, { deleted: true }), rc("h-old", "n::s", "l", 60)]);
    expect(rows.state.homes[0].rows.map((x) => x.address)).toEqual(["a::s", "n::s"]);
    expect(rows.orphans).toBe(0);
  });

  it("outbox items naming a merged-away Home follow the redirect", () => {
    const box: ChangeItem[] = [
      rc("h-old", "a::s", "V", 5, { by: ME }),
      hc("h-old", "Renamed", "V", 5, { by: ME }),
      hc("h-gone", "", "", 5, { by: ME, deleted: true }),
      rc("h2", "b::s", "V", 5, { by: ME }),
    ];
    const out = redirectOutbox(box, { "h-old": "h1", "h-gone": "h1" });
    expect(out.map((c) => (c.kind === "row" ? `${c.homeId}|${c.address}` : `${c.id}${c.deleted ? " x" : ""}`))).toEqual([
      "h1|a::s",
      "h-gone x",
      "h2|b::s",
    ]);
    expect(redirectOutbox(box, {})).toBe(box);
  });

  it("first sync follows the server's redirects for a Home this phone had before", () => {
    const local = state([home("h-old", "Mine", [row("a::s", { order: "V", updatedAt: 5 })], { order: "V", updatedAt: 5 })]);
    const remote: ChangeItem[] = [hc("h1", "Home", "V", 50), hc("h-old", "", "", 50, { deleted: true, mergedInto: "h1" })];
    const r = firstSyncMerge(local, remote, { now: 100, by: ME, redirects: { "h-old": "h1" } });
    expect(r.state.homes.map((h) => [h.id, h.rows.map((x) => x.address)])).toEqual([["h1", ["a::s"]]]);
    expect(r.state.redirects).toEqual({ "h-old": "h1" });
    expect(r.changes).toEqual([expect.objectContaining({ kind: "row", homeId: "h1", address: "a::s" })]);
  });
});

describe("synced mark + full resync (reconcileFull)", () => {
  const S = { synced: true };
  const synced = state([
    home("h1", "Home", [{ ...row("a::s", { order: "V", updatedAt: 1 }), ...S }, row("new::s", { order: "x", updatedAt: 2 })], {
      order: "V",
      updatedAt: 1,
      ...S,
    }),
    home("h2", "Old", [{ ...row("b::s", { order: "V", updatedAt: 1 }), ...S }], { order: "l", updatedAt: 1, ...S }),
    home("h3", "Mixed", [{ ...row("c::s", { order: "V", updatedAt: 1 }), ...S }, row("d::s", { order: "l", updatedAt: 3 })], {
      order: "t",
      updatedAt: 1,
      ...S,
    }),
    home("h4", "Offline", [row("e::s", { order: "V", updatedAt: 4 })], { order: "x", updatedAt: 4 }),
  ]);

  it("applyRemote marks what the server sent, including an echo or a losing write", () => {
    const plain = state([home("h1", "Home", [row("a::s", { order: "V", updatedAt: 10 })], { order: "V", updatedAt: 10 })]);
    const echo = applyRemote(plain, [hc("h1", "Home", "V", 10, { by: undefined }), { ...rc("h1", "a::s", "V", 10), by: undefined }]);
    expect(echo.state.homes[0].synced).toBe(true);
    expect(echo.state.homes[0].rows[0].synced).toBe(true);
    const lost = applyRemote(plain, [hc("h1", "Old", "V", 5)]);
    expect(lost.state.homes[0]).toMatchObject({ name: "Home", synced: true });
    expect(applyRemote(plain, [hc("h9", "New", "l", 5)]).state.homes.find((h) => h.id === "h9")?.synced).toBe(true);
  });

  it("drops synced items the full set lacks; keeps + pushes local-only ones; a Home with local-only rows stays", () => {
    // The server's full set holds only h1 + a::s.
    const full: ChangeItem[] = [hc("h1", "Home", "V", 1), rc("h1", "a::s", "V", 1)];
    const r = reconcileFull(synced, full);
    expect(r.changed).toBe(true);
    expect(r.state.homes.map((h) => [h.id, h.rows.map((x) => x.address)])).toEqual([
      ["h1", ["a::s", "new::s"]],
      ["h3", ["d::s"]],
      ["h4", ["e::s"]],
    ]);
    expect(r.dropped.sort()).toEqual(["h|h2", "r|h2|b::s", "r|h3|c::s"]);
    expect(r.push.map((c) => (c.kind === "home" ? `h|${c.id}` : `r|${c.homeId}|${c.address}`))).toEqual([
      "r|h1|new::s",
      "h|h3",
      "r|h3|d::s",
      "h|h4",
      "r|h4|e::s",
    ]);
    // No tombstones for what was dropped.
    expect(r.state.tombstones).toEqual([]);
  });

  it("unmarked (legacy) items are never dropped", () => {
    const legacy = state([home("h1", "Home", [row("a::s", { order: "V", updatedAt: 0 })], { order: "V" })]);
    const r = reconcileFull(legacy, []);
    expect(r.changed).toBe(false);
    expect(r.state).toBe(legacy);
    expect(r.push).toHaveLength(2);
  });

  it("markSyncedKeys marks only the named items (null when nothing changes)", () => {
    const next = markSyncedKeys(synced.homes, ["r|h1|new::s", "h|h4"])!;
    expect(next[0].rows[1].synced).toBe(true);
    expect(next[3].synced).toBe(true);
    expect(next[3].rows[0].synced).toBeUndefined();
    expect(markSyncedKeys(next, ["r|h1|new::s"])).toBeNull();
  });

  it("first sync clears marks from another server and marks what this server holds", () => {
    const local = state([
      home("mine", "Home", [{ ...row("a::s", { order: "V", updatedAt: 1 }), ...S }], { order: "V", updatedAt: 1, ...S }),
      home("solo", "Solo", [], { order: "l", updatedAt: 1, ...S }),
    ]);
    const r = firstSyncMerge(local, [hc("srv", "Home", "V", 5), rc("srv", "b::s", "V", 5)], { now: 100, by: ME });
    const srv = r.state.homes.find((h) => h.id === "srv")!;
    expect(srv.synced).toBe(true);
    expect(srv.rows.find((x) => x.address === "b::s")?.synced).toBe(true);
    expect(srv.rows.find((x) => x.address === "a::s")?.synced).toBeUndefined();
    expect(r.state.homes.find((h) => h.id === "solo")?.synced).toBeUndefined();
  });
});
