// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOMES_STORAGE_KEY,
  LIST_TAB_KEY,
  homeAddress,
  onHomesLocalChange,
  parseHomeAddress,
  parseHomesDoc,
  readListTab,
  selectedHome,
  useHomesStore,
  writeListTab,
} from "./homes";
import type { ChangeItem } from "./homesMerge";

const row = (handle: string, host = "example.k2.dev") => ({
  address: homeAddress(handle, host),
  workspaceId: `w-${handle}`,
  label: handle,
});

function stored() {
  return parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY));
}

beforeEach(() => {
  localStorage.clear();
  useHomesStore.getState().reload();
});

describe("Home store (HM2)", () => {
  it("seeds one empty Home called Home on first use, in desktop's shape", () => {
    expect(localStorage.getItem(HOMES_STORAGE_KEY)).toBeNull();
    useHomesStore.getState().ensureSeeded();
    const doc = stored();
    expect(doc?.version).toBe(1);
    expect(doc?.homes).toHaveLength(1);
    expect(doc?.homes[0].name).toBe("Group 1");
    expect(doc?.homes[0].rows).toEqual([]);
    // A second call keeps the same Home.
    const id = doc?.homes[0].id;
    useHomesStore.getState().ensureSeeded();
    expect(stored()?.homes[0].id).toBe(id);
  });

  it("never overwrites a stored value it does not recognise", () => {
    localStorage.setItem(HOMES_STORAGE_KEY, JSON.stringify({ version: 2, homes: [] }));
    useHomesStore.getState().reload();
    useHomesStore.getState().ensureSeeded();
    expect(JSON.parse(localStorage.getItem(HOMES_STORAGE_KEY) as string).version).toBe(2);
  });

  it("adds rows, dedupes by address (case-insensitive), removes them", () => {
    const s = useHomesStore.getState();
    const id = s.selectedId;
    expect(s.addRow(id, row("alpha"))).toBe(true);
    expect(useHomesStore.getState().addRow(id, { ...row("alpha"), address: "ALPHA::Example.K2.dev" })).toBe(false);
    expect(useHomesStore.getState().addRow(id, row("bravo"))).toBe(true);
    expect(stored()?.homes[0].rows.map((r) => r.address)).toEqual([
      "alpha::example.k2.dev",
      "bravo::example.k2.dev",
    ]);
    useHomesStore.getState().moveRow(id, 1, 0);
    expect(stored()?.homes[0].rows[0].address).toBe("bravo::example.k2.dev");
    useHomesStore.getState().removeRow(id, "alpha::example.k2.dev");
    expect(stored()?.homes[0].rows.map((r) => r.label)).toEqual(["bravo"]);
  });

  it("refuses a malformed address", () => {
    const s = useHomesStore.getState();
    expect(s.addRow(s.selectedId, { address: "no-host", workspaceId: null, label: "x" })).toBe(false);
    expect(parseHomeAddress("alpha::example.k2.dev")).toEqual({ handle: "alpha", host: "example.k2.dev" });
  });

  it("creates (and selects), renames, deletes; the last Home is protected", () => {
    const first = useHomesStore.getState().selectedId;
    expect(useHomesStore.getState().createHome("   ")).toBeNull();
    const work = useHomesStore.getState().createHome("  Work  ") as string;
    expect(useHomesStore.getState().selectedId).toBe(work);
    expect(selectedHome(useHomesStore.getState()).name).toBe("Work");
    expect(useHomesStore.getState().renameHome(work, "Office")).toBe(true);
    expect(useHomesStore.getState().renameHome(work, "")).toBe(false);
    expect(stored()?.homes.map((h) => h.name)).toEqual(["Group 1", "Office"]);
    expect(useHomesStore.getState().deleteHome(work)).toBe(true);
    expect(useHomesStore.getState().selectedId).toBe(first);
    expect(useHomesStore.getState().deleteHome(first)).toBe(false);
    expect(stored()?.homes).toHaveLength(1);
  });

  it("remembers the selected Home across a reload", () => {
    const work = useHomesStore.getState().createHome("Work") as string;
    useHomesStore.getState().selectHome(useHomesStore.getState().homes[0].id);
    useHomesStore.getState().selectHome(work);
    useHomesStore.getState().reload();
    expect(useHomesStore.getState().selectedId).toBe(work);
  });
});

describe("Move to group on a Home row (moveRowToHome)", () => {
  function twoHomes() {
    const s = useHomesStore.getState();
    s.ensureSeeded();
    const first = useHomesStore.getState().selectedId;
    useHomesStore.getState().addRow(first, row("alpha"));
    useHomesStore.getState().addRow(first, row("bravo"));
    const second = useHomesStore.getState().createHome("Work") as string;
    useHomesStore.getState().addRow(second, row("charlie"));
    useHomesStore.getState().selectHome(first);
    return { first, second };
  }

  it("takes the row off one Home and puts it on the end of the other, as one synced edit", () => {
    const { first, second } = twoHomes();
    expect(useHomesStore.getState().pinRow(first, "alpha::example.k2.dev")).toBe("pinned");
    useHomesStore.getState().stampRowsMessaged((r) => r.label === "alpha", 1234);
    const seen: ChangeItem[] = [];
    const stop = onHomesLocalChange((c) => seen.push(...c));
    expect(useHomesStore.getState().moveRowToHome(first, second, "ALPHA::example.k2.dev")).toBe(true);
    stop();
    const doc = stored();
    const from = doc?.homes.find((h) => h.id === first);
    const to = doc?.homes.find((h) => h.id === second);
    expect(from?.rows.map((r) => r.label)).toEqual(["bravo"]);
    expect(to?.rows.map((r) => r.label)).toEqual(["charlie", "alpha"]);
    const moved = to?.rows[1];
    // Its identity and hints go with it; pins are per Home, so not the pin.
    expect(moved).toMatchObject({ address: "alpha::example.k2.dev", workspaceId: "w-alpha", label: "alpha", lastMessagedAt: 1234 });
    expect(moved?.pinOrder).toBeUndefined();
    expect(moved?.synced).toBeUndefined();
    expect(typeof moved?.order).toBe("string");
    expect(moved!.order! > to!.rows[0].order!).toBe(true);
    // Sync: a tombstone for the old row and a new row on the other Home,
    // both stamped by this edit; the selection stays.
    expect(doc?.tombstones).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "row", homeId: first, address: "alpha::example.k2.dev" })])
    );
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "row", homeId: first, address: "alpha::example.k2.dev", deleted: true }),
        expect.objectContaining({ kind: "row", homeId: second, address: "alpha::example.k2.dev", label: "alpha" }),
      ])
    );
    const live = seen.find((c) => c.kind === "row" && c.homeId === second && !c.deleted);
    expect(live && "pinOrder" in live ? live.pinOrder : undefined).toBeUndefined();
    expect(seen.filter((c) => c.kind === "home")).toEqual([]);
    expect(useHomesStore.getState().selectedId).toBe(first);
  });

  it("onto a Home that already has it: just comes off the first", () => {
    const { first, second } = twoHomes();
    useHomesStore.getState().addRow(second, row("alpha"));
    expect(useHomesStore.getState().moveRowToHome(first, second, "alpha::example.k2.dev")).toBe(true);
    const homes = useHomesStore.getState().homes;
    expect(homes.find((h) => h.id === first)?.rows.map((r) => r.label)).toEqual(["bravo"]);
    expect(homes.find((h) => h.id === second)?.rows.map((r) => r.label)).toEqual(["charlie", "alpha"]);
  });

  it("moving back revives the row on its first Home (newer than its tombstone)", () => {
    const { first, second } = twoHomes();
    useHomesStore.getState().moveRowToHome(first, second, "alpha::example.k2.dev");
    const tomb = useHomesStore.getState().tombstones.find((t) => t.kind === "row" && t.homeId === first);
    expect(useHomesStore.getState().moveRowToHome(second, first, "alpha::example.k2.dev")).toBe(true);
    const s = useHomesStore.getState();
    const back = s.homes.find((h) => h.id === first)?.rows.find((r) => r.label === "alpha");
    expect(back?.updatedAt).toBeGreaterThan(tomb!.updatedAt);
    expect(s.tombstones.some((t) => t.kind === "row" && t.homeId === first && t.address === "alpha::example.k2.dev")).toBe(false);
    expect(s.tombstones.some((t) => t.kind === "row" && t.homeId === second && t.address === "alpha::example.k2.dev")).toBe(true);
  });

  it("refuses the same Home, a gone Home, or a row that isn't there", () => {
    const { first, second } = twoHomes();
    const before = localStorage.getItem(HOMES_STORAGE_KEY);
    expect(useHomesStore.getState().moveRowToHome(first, first, "alpha::example.k2.dev")).toBe(false);
    expect(useHomesStore.getState().moveRowToHome(first, "gone", "alpha::example.k2.dev")).toBe(false);
    expect(useHomesStore.getState().moveRowToHome(second, first, "alpha::example.k2.dev")).toBe(false);
    expect(localStorage.getItem(HOMES_STORAGE_KEY)).toBe(before);
  });
});

describe("list tab (HM1)", () => {
  it("defaults to Agents and remembers Home", () => {
    expect(readListTab()).toBe("agents");
    writeListTab("home");
    expect(localStorage.getItem(LIST_TAB_KEY)).toBe("home");
    expect(readListTab()).toBe("home");
    localStorage.setItem(LIST_TAB_KEY, "junk");
    expect(readListTab()).toBe("agents");
  });
});

describe("one address rule with the merged list (multi-server MS1/MS15)", () => {
  it("Home and the merged list spell and parse `handle::hostKey` the same way", async () => {
    const { homeAddress, parseHomeAddress } = await import("./homes");
    const { rowAddress, parseRowAddress } = await import("./multi/merge");
    const { serverHostKey } = await import("../stores/servers");
    const entries = [
      { url: "https://Riley.K2.dev" },
      { url: "https://riley.k2.dev:8443" },
      { url: "http://127.0.0.1:7777" },
      { url: "https://[fe80::1]:9000" },
    ];
    for (const e of entries) {
      const key = serverHostKey(e);
      const agent = { id: "/ws", addr: "k2", kind: "agent" as const };
      expect(homeAddress("k2", key)).toBe(rowAddress(agent, key));
      const home = parseHomeAddress(homeAddress("k2/reviewer", key));
      const row = parseRowAddress(rowAddress({ ...agent, addr: "k2/reviewer" }, key));
      expect(home).toEqual({ handle: row?.handle, host: row?.hostKey });
    }
    expect(serverHostKey({ url: "https://Riley.K2.dev" })).toBe("riley.k2.dev");
  });
});

describe("rename repair (S3b, desktop repairRows)", () => {
  it("re-keys a row, drops one whose new address is already on that Home, keeps the first of two", () => {
    const h = useHomesStore.getState();
    const id = h.selectedId;
    h.addRow(id, row("old"));
    h.addRow(id, row("kept"));
    h.addRow(id, row("dup"));
    h.addRow(id, row("twin-a"));
    h.addRow(id, row("twin-b"));
    useHomesStore.getState().repairRows((r) => {
      const p = parseHomeAddress(r.address)!;
      if (p.handle === "old") return { address: homeAddress("new", p.host), workspaceId: "w-old", label: "New" };
      if (p.handle === "dup") return { ...r, address: homeAddress("kept", p.host) };
      if (p.handle.startsWith("twin")) return { ...r, address: homeAddress("twin", p.host) };
      return null;
    });
    const rows = stored()!.homes[0].rows;
    expect(rows.map((r) => r.address)).toEqual([
      "new::example.k2.dev",
      "kept::example.k2.dev",
      "twin::example.k2.dev",
    ]);
    expect(rows[0]).toMatchObject({ address: "new::example.k2.dev", workspaceId: "w-old", label: "New" });
  });

  it("writes nothing when no row changes", () => {
    const h = useHomesStore.getState();
    h.addRow(h.selectedId, row("a"));
    const before = localStorage.getItem(HOMES_STORAGE_KEY);
    const homes = useHomesStore.getState().homes;
    useHomesStore.getState().repairRows((r) => ({ ...r }));
    expect(useHomesStore.getState().homes).toBe(homes);
    expect(localStorage.getItem(HOMES_STORAGE_KEY)).toBe(before);
  });
});
