// @vitest-environment jsdom
// Homes sync (K2 0.46.1): rows move from `handle::hostKey` to
// `handle::serverId` once a saved server's /boot-status reports its box
// id; until then (and after) both spellings resolve.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore, type ServerEntry } from "../stores/servers";
import {
  HOME_SERVER_IDS_KEY,
  boxIdForSaved,
  canonicalHomeHost,
  entryMatchesHomeHost,
  homeHostFor,
  homeHostLabel,
  useHomeServerIds,
} from "./homeServerIds";
import { canonicalHomeAddress, homeHasAddress, onHomesLocalChange, useHomesStore } from "./homes";
import { renameRepairFor, resolveHomeRows, savedServerForHost } from "./homeView";
import type { ChangeItem } from "./homesMerge";
import type { ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";

const BOX_A = "aaaaaaaaaaaaaaaa";
const BOX_B = "bbbbbbbbbbbbbbbb";
const A: ServerEntry = { id: "a", nickname: "Alpha", url: "https://alpha.k2.dev", username: "u", rememberPassword: false };
const B: ServerEntry = { id: "b", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };

function agent(addr: string, path: string): StubAgent {
  return { id: path, name: addr, initial: addr[0].toUpperCase(), path, addr, kind: "agent" };
}
function proj(id: string, handle: string, path: string): ServerProject {
  return { id, name: handle, handle, path, pinned: false, tabOrder: 0, focusGroupId: null };
}

beforeEach(() => {
  localStorage.clear();
  __resetScopesForTests();
  useHomeServerIds.getState().reload();
  useHomesStore.getState().reload();
  useServersStore.setState({ servers: [A, B], activeServerId: "a", tokens: { a: "t", b: "t" }, hydrated: true });
});
afterEach(() => {
  useHomeServerIds.setState({ bySaved: {}, hostByBox: {}, hinted: {} });
});

describe("box ids from /boot-status", () => {
  it("records serverId per saved server (persisted); unknown before, host key fallback", () => {
    expect(homeHostFor(B)).toBe("bravo.k2.dev");
    noteBootStatus("b", { version: "0.46.1", serverId: BOX_B.toUpperCase() });
    expect(boxIdForSaved("b")).toBe(BOX_B);
    expect(homeHostFor(B)).toBe(BOX_B);
    expect(JSON.parse(localStorage.getItem(HOME_SERVER_IDS_KEY)!).bySaved).toEqual({ b: BOX_B });
    // A malformed or missing serverId (older daemon) is ignored.
    noteBootStatus("a", { version: "0.46.0", serverId: "local" });
    expect(boxIdForSaved("a")).toBeNull();
  });

  it("either form names the server; canonical form is the box id", () => {
    noteBootStatus("b", { serverId: BOX_B });
    expect(entryMatchesHomeHost(B, "bravo.k2.dev")).toBe(true);
    expect(entryMatchesHomeHost(B, BOX_B)).toBe(true);
    expect(entryMatchesHomeHost(A, BOX_B)).toBe(false);
    expect(canonicalHomeHost("bravo.k2.dev")).toBe(BOX_B);
    expect(canonicalHomeHost("alpha.k2.dev")).toBe("alpha.k2.dev");
    expect(canonicalHomeAddress("Docs::Bravo.k2.dev")).toBe(`docs::${BOX_B}`);
    expect(savedServerForHost([A, B], BOX_B)).toBe(B);
  });

  it("removing the server forgets its box id; the label fallback remembers the host", () => {
    noteBootStatus("b", { serverId: BOX_B });
    useServersStore.getState().removeServer("b");
    expect(boxIdForSaved("b")).toBeNull();
    expect(homeHostLabel(BOX_B)).toBe("bravo.k2.dev");
  });
});

describe("migration hostKey → serverId", () => {
  it("rewrites rows once the box id is known, tombstones the old spelling, queues both", () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "docs::bravo.k2.dev", workspaceId: "pd", label: "docs" });
    s.addRow(s.selectedId, { address: "alpha::alpha.k2.dev", workspaceId: "pa", label: "alpha" });
    const seen: ChangeItem[] = [];
    const stop = onHomesLocalChange((c) => seen.push(...c));
    expect(useHomesStore.getState().migrateAddresses()).toBe(false); // nothing known yet
    noteBootStatus("b", { serverId: BOX_B });
    expect(useHomesStore.getState().migrateAddresses()).toBe(true);
    stop();
    const rows = useHomesStore.getState().homes[0].rows;
    expect(rows.map((r) => r.address)).toEqual([`docs::${BOX_B}`, "alpha::alpha.k2.dev"]);
    // Same place in the list, same workspace hint.
    expect(rows[0].workspaceId).toBe("pd");
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "row", address: `docs::${BOX_B}` }),
        expect.objectContaining({ kind: "row", address: "docs::bravo.k2.dev", deleted: true }),
      ])
    );
    expect(useHomesStore.getState().migrateAddresses()).toBe(false);
  });

  it("Add Agent dedupes across spellings; remove takes either spelling off", () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "docs::bravo.k2.dev", workspaceId: null, label: "docs" });
    noteBootStatus("b", { serverId: BOX_B });
    const home = useHomesStore.getState().homes[0];
    expect(homeHasAddress(home, `docs::${BOX_B}`)).toBe(true);
    expect(useHomesStore.getState().addRow(home.id, { address: `docs::${BOX_B}`, workspaceId: null, label: "docs" })).toBe(false);
    useHomesStore.getState().removeRow(home.id, `docs::${BOX_B}`);
    expect(useHomesStore.getState().homes[0].rows).toEqual([]);
  });
});

describe("resolution reads both forms", () => {
  it("resolveHomeRows: box-id rows on the active and another server; unknown box shows its last host", () => {
    noteBootStatus("a", { serverId: BOX_A });
    noteBootStatus("b", { serverId: BOX_B });
    const views = resolveHomeRows(
      [
        { address: `alpha::${BOX_A}`, workspaceId: "pa", label: "alpha" },
        { address: "alpha::alpha.k2.dev", workspaceId: "pa", label: "alpha old" },
        { address: `docs::${BOX_B}`, workspaceId: "pd", label: "docs" },
        { address: "x::cccccccccccccccc", workspaceId: null, label: "x" },
      ],
      { activeHostKey: "alpha.k2.dev", agents: [agent("alpha", "/a")], projects: [proj("pa", "alpha", "/a")], servers: [A, B] }
    );
    expect(views.map((v) => v.kind)).toEqual(["here", "here", "remote", "remote"]);
    expect(views[2].kind === "remote" && views[2].server).toBe(B);
    expect(views[3].kind === "remote" && views[3].serverLabel).toBe("cccccccccccccccc");
  });

  it("rename repair follows a row in either form and writes the box id", () => {
    const repair = renameRepairFor("bravo.k2.dev", [proj("pd", "docs2", "/d")], [], BOX_B);
    expect(repair({ address: `docs::${BOX_B}`, workspaceId: "pd", label: "docs" })).toEqual({
      address: `docs2::${BOX_B}`,
      workspaceId: "pd",
      label: "docs2",
    });
    expect(repair({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "docs" })?.address).toBe(`docs2::${BOX_B}`);
  });
});

describe("hints: the pull's servers map and /boot-status publicHost (K2 0.46.1 final)", () => {
  const BOX_C = "cccccccccccccccc";

  it("servers{hostKey: serverId} fills saved servers with no box id; never overrides /boot-status", () => {
    noteBootStatus("a", { serverId: BOX_A });
    useHomeServerIds.getState().hint({ "alpha.k2.dev": BOX_C, "Bravo.K2.dev": BOX_B.toUpperCase(), "peer.k2.dev": BOX_C, junk: "nope" });
    expect(boxIdForSaved("a")).toBe(BOX_A); // its own /boot-status wins
    expect(boxIdForSaved("b")).toBe(BOX_B);
    expect(homeHostFor(B)).toBe(BOX_B);
    expect(canonicalHomeHost("bravo.k2.dev")).toBe(BOX_B);
    // An unsaved peer: its rows still get the box id; labels fall back.
    expect(canonicalHomeHost("peer.k2.dev")).toBe(BOX_C);
    expect(homeHostLabel(BOX_C)).toBe("alpha.k2.dev");
    expect(JSON.parse(localStorage.getItem(HOME_SERVER_IDS_KEY)!).hinted).toMatchObject({ "bravo.k2.dev": BOX_B, "peer.k2.dev": BOX_C });
    // A later /boot-status is the truth.
    noteBootStatus("b", { serverId: BOX_C });
    expect(boxIdForSaved("b")).toBe(BOX_C);
  });

  it("rows migrate from a hint alone (no /boot-status read)", () => {
    const s = useHomesStore.getState();
    s.addRow(s.selectedId, { address: "docs::bravo.k2.dev", workspaceId: null, label: "docs" });
    useHomeServerIds.getState().hint({ "bravo.k2.dev": BOX_B });
    expect(useHomesStore.getState().migrateAddresses()).toBe(true);
    expect(useHomesStore.getState().homes[0].rows.map((r) => r.address)).toEqual([`docs::${BOX_B}`]);
  });

  it("/boot-status publicHost names the box too", () => {
    noteBootStatus("a", { serverId: BOX_A, publicHost: "https://Rosson.k2.dev/" });
    expect(useHomeServerIds.getState().hinted["rosson.k2.dev"]).toBe(BOX_A);
    expect(canonicalHomeHost("rosson.k2.dev")).toBe(BOX_A);
  });
});
