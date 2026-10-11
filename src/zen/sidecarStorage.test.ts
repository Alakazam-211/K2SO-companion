// @vitest-environment jsdom
// Multi-server MA6 / MA8: remembered sidecars and hidden extras are kept
// per server id. The pre-multi-server single list is adopted once, by the
// active server only, then removed.
import { beforeEach, describe, expect, it } from "vitest";
import {
  SIDECAR_STORAGE_KEY,
  forgetRememberedSidecars,
  readRememberedSidecars,
  rememberSidecar,
  sidecarStorageKey,
} from "./sidecarRows";
import {
  HIDDEN_SIDECAR_KEY,
  hiddenSidecarKey,
  hideSidecarAddr,
  readHiddenSidecarAddrs,
  unhideSidecarAddr,
} from "./overlayExtras";
import { sidecarRowId } from "./agentRow";

const ROW = { addr: "k2/1", path: "/ws", name: "K2", chatTitle: "Reviewer" };

beforeEach(() => localStorage.clear());

describe("remembered sidecars per server", () => {
  it("a sidecar remembered on A is not listed on B", () => {
    rememberSidecar("A", ROW);
    expect(readRememberedSidecars("A").map((r) => r.addr)).toEqual(["k2/1"]);
    expect(readRememberedSidecars("B")).toEqual([]);
    expect(localStorage.getItem(sidecarStorageKey("A"))).toContain("k2/1");
  });

  it("the legacy list is adopted by the active server once, then removed", () => {
    localStorage.setItem(SIDECAR_STORAGE_KEY, JSON.stringify([ROW]));
    // Another server reading first never claims it.
    expect(readRememberedSidecars("B")).toEqual([]);
    expect(localStorage.getItem(SIDECAR_STORAGE_KEY)).not.toBeNull();
    expect(readRememberedSidecars("A", { adoptLegacy: true }).map((r) => r.addr)).toEqual(["k2/1"]);
    expect(localStorage.getItem(SIDECAR_STORAGE_KEY)).toBeNull();
    expect(readRememberedSidecars("A").map((r) => r.addr)).toEqual(["k2/1"]);
  });

  it("an existing per-server list wins over the legacy one", () => {
    rememberSidecar("A", { ...ROW, addr: "k2/2" });
    localStorage.setItem(SIDECAR_STORAGE_KEY, JSON.stringify([ROW]));
    expect(readRememberedSidecars("A", { adoptLegacy: true }).map((r) => r.addr)).toEqual(["k2/2"]);
    expect(localStorage.getItem(SIDECAR_STORAGE_KEY)).toBeNull();
  });

  it("forget drops only that server's list", () => {
    rememberSidecar("A", ROW);
    rememberSidecar("B", ROW);
    forgetRememberedSidecars("A");
    expect(readRememberedSidecars("A")).toEqual([]);
    expect(readRememberedSidecars("B")).toHaveLength(1);
  });

  it("no server id → nothing read or written", () => {
    rememberSidecar("", ROW);
    expect(readRememberedSidecars("")).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
});

describe("hidden extras per server", () => {
  it("hiding on A leaves B alone", () => {
    hideSidecarAddr("A", "k2/1");
    expect(readHiddenSidecarAddrs("A")).toEqual(["k2/1"]);
    expect(readHiddenSidecarAddrs("B")).toEqual([]);
    expect(localStorage.getItem(hiddenSidecarKey("A"))).toContain("k2/1");
    unhideSidecarAddr("A", "k2/1");
    expect(readHiddenSidecarAddrs("A")).toEqual([]);
  });

  it("adopts the legacy hidden list for the active server", () => {
    localStorage.setItem(HIDDEN_SIDECAR_KEY, JSON.stringify(["k2/1"]));
    expect(readHiddenSidecarAddrs("A", { adoptLegacy: true })).toEqual(["k2/1"]);
    expect(localStorage.getItem(HIDDEN_SIDECAR_KEY)).toBeNull();
  });
});

describe("row ids (MA8)", () => {
  it("a sidecar row id never carries the :: address separator", () => {
    expect(sidecarRowId("/ws", "k2/1")).toBe("/ws#k2/1");
    expect(sidecarRowId("/ws", "k2/1")).not.toContain("::");
  });
});
