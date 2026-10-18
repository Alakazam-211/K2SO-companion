import { describe, expect, it } from "vitest";
import {
  TOMBSTONE_MAX_AGE_MS,
  applyRemote,
  coalesceOutbox,
  compareStamp,
  diffLocal,
  firstSyncMerge,
  incomingWins,
  migrateHomeAddresses,
  pruneTombstones,
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
    expect(d.homes[0]).toMatchObject({ updatedAt: 1000, by: ME, order: "a0" });
    expect(d.homes[0].rows.map((r) => r.order)).toEqual(["a0", "a1"]);
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
  const local = state([home("h1", "Home", [row("a::s", { order: "a0", updatedAt: 10 })], { order: "a0", updatedAt: 10 })]);

  it("newer remote edits win; older ones lose", () => {
    const r1 = applyRemote(local, [hc("h1", "Office", "a0", 20)]);
    expect(r1.state.homes[0].name).toBe("Office");
    const r2 = applyRemote(local, [hc("h1", "Old", "a0", 5)]);
    expect(r2.changed).toBe(false);
    expect(r2.state.homes[0].name).toBe("Home");
  });

  it("ties break by device id", () => {
    const tied = state([home("h1", "Mine", [], { order: "a0", updatedAt: 10, by: "m" })]);
    expect(applyRemote(tied, [hc("h1", "Theirs", "a0", 10, { by: "z" })]).state.homes[0].name).toBe("Theirs");
    expect(applyRemote(tied, [hc("h1", "Theirs", "a0", 10, { by: "a" })]).state.homes[0].name).toBe("Mine");
  });

  it("a remote tombstone beats an older edit; an older tombstone does not", () => {
    const del = applyRemote(local, [rc("h1", "a::s", "", 11, { deleted: true })]);
    expect(del.state.homes[0].rows).toEqual([]);
    expect(del.state.tombstones).toEqual([expect.objectContaining({ kind: "row", address: "a::s", updatedAt: 11 })]);
    const stale = applyRemote(local, [rc("h1", "a::s", "", 9, { deleted: true })]);
    expect(stale.changed).toBe(false);
  });

  it("a local tombstone blocks an older remote re-add, not a newer one", () => {
    const withTomb = state([home("h1", "Home", [], { order: "a0", updatedAt: 10 })], {
      tombstones: [{ kind: "row", homeId: "h1", address: "a::s", updatedAt: 50 }],
    });
    expect(applyRemote(withTomb, [rc("h1", "a::s", "a0", 40)]).changed).toBe(false);
    const back = applyRemote(withTomb, [rc("h1", "a::s", "a0", 60)]);
    expect(back.state.homes[0].rows.map((r) => r.address)).toEqual(["a::s"]);
    expect(back.state.tombstones).toEqual([]);
  });

  it("a deleted Home drops; a new Home is added and sorted by order", () => {
    const two = applyRemote(local, [hc("h0", "First", "Zz", 5), rc("h0", "x::s", "a0", 5)]);
    expect(two.state.homes.map((h) => h.id)).toEqual(["h0", "h1"]);
    expect(two.state.homes[0].rows.map((r) => r.address)).toEqual(["x::s"]);
    const gone = applyRemote(two.state, [hc("h0", "", "", 6, { deleted: true })]);
    expect(gone.state.homes.map((h) => h.id)).toEqual(["h1"]);
  });

  it("concurrent reorders converge on one order on every device", () => {
    const base = state([
      home("h1", "Home", [
        row("a::s", { order: "a0", updatedAt: 1 }),
        row("b::s", { order: "a1", updatedAt: 1 }),
        row("c::s", { order: "a2", updatedAt: 1 }),
      ], { order: "a0", updatedAt: 1 }),
    ]);
    // Device A moves c to the top; device B moves a to the bottom.
    const fromA = rc("h1", "c::s", "Zz", 100, { by: "dev-a" });
    const fromB = rc("h1", "a::s", "a3", 101, { by: "dev-b" });
    const onA = applyRemote(applyRemote(base, [fromA]).state, [fromB]).state;
    const onB = applyRemote(applyRemote(base, [fromB]).state, [fromA]).state;
    const order = (s: SyncState) => s.homes[0].rows.map((r) => r.address);
    expect(order(onA)).toEqual(["c::s", "b::s", "a::s"]);
    expect(order(onB)).toEqual(order(onA));
  });

  it("rows for an unknown Home are orphans (full re-pull); for a deleted Home, ignored", () => {
    expect(applyRemote(local, [rc("hX", "q::s", "a0", 5)]).orphans).toBe(1);
    const tomb = state([], { tombstones: [{ kind: "home", id: "hX", updatedAt: 9 }] });
    expect(applyRemote(tomb, [rc("hX", "q::s", "a0", 5)]).orphans).toBe(0);
  });

  it("follows first-sync redirects", () => {
    const red = state(local.homes.map((h) => ({ ...h, id: "srv" })), { redirects: { h1: "srv" } });
    expect(resolveHomeId(red.redirects, "h1")).toBe("srv");
    expect(applyRemote(red, [rc("h1", "z::s", "a1", 20)]).state.homes[0].rows.map((r) => r.address)).toEqual(["a::s", "z::s"]);
  });

  it("our own echo changes nothing", () => {
    const echo = applyRemote(local, [{ ...rc("h1", "a::s", "a0", 10), by: undefined }]);
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
      hc("srv-home", "home", "a0", 50),
      rc("srv-home", "b::s", "a0", 50, { label: "B from desktop" }),
      rc("srv-home", "c::s", "a1", 50),
      hc("srv-work", "Work", "a1", 50),
      rc("srv-work", "w::s", "a0", 50),
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
    const keyedLocal = state([home("h1", "Home", [row("a::s", { updatedAt: 5, order: "a0" })], { updatedAt: 5, order: "a0" })]);
    const remote: ChangeItem[] = [hc("h1", "Home", "a0", 5), rc("h1", "a::s", "", 9, { deleted: true })];
    const r = firstSyncMerge(keyedLocal, remote, { now: 1000, by: ME });
    expect(r.state.homes[0].rows.map((x) => x.address)).toEqual(["a::s"]);
    expect(r.changes).toEqual([expect.objectContaining({ kind: "row", address: "a::s", updatedAt: 1000, by: ME })]);
  });

  it("an empty server gets everything; an empty phone gets the server's", () => {
    const up = firstSyncMerge(local, [], { now: 1, by: ME });
    expect(up.state.homes.map((h) => h.id)).toEqual(["loc-home", "loc-lab"]);
    expect(up.changes.filter((c) => c.kind === "row")).toHaveLength(3);
    const down = firstSyncMerge(state([]), [hc("s1", "Home", "a0", 1), rc("s1", "a::s", "a0", 1)], { now: 2, by: ME });
    expect(down.state.homes.map((h) => h.id)).toEqual(["s1"]);
    expect(down.changes).toEqual([]);
  });
});

describe("outbox + tombstones", () => {
  it("coalesces by key (latest write) and settles what was sent or rejected", () => {
    const a1 = rc("h", "a::s", "a0", 1);
    const a2 = rc("h", "a::s", "a0", 2);
    const b = rc("h", "b::s", "a1", 1);
    const box = coalesceOutbox([a1, b], [a2]);
    expect(box).toEqual([a2, b]);
    // Sent a1, but a2 was written since: a2 stays.
    expect(settleOutbox(box, [a1])).toEqual([a2, b]);
    expect(settleOutbox(box, [a2])).toEqual([b]);
    expect(settleOutbox(box, [], ["r|h|b::s"])).toEqual([a2]);
  });

  it("prunes tombstones older than 30 days", () => {
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
