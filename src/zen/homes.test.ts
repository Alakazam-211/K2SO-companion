// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOMES_STORAGE_KEY,
  LIST_TAB_KEY,
  homeAddress,
  parseHomeAddress,
  parseHomesDoc,
  readListTab,
  selectedHome,
  useHomesStore,
  writeListTab,
} from "./homes";

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
    expect(doc?.homes[0].name).toBe("Home");
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
    expect(stored()?.homes.map((h) => h.name)).toEqual(["Home", "Office"]);
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
