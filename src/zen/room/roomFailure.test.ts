// MS36: the room banner's state, copy and ONE action per state (§6.8 / MA41
// copy, the list's words), scoped to the room's server.
import { describe, expect, it } from "vitest";
import { blankEntry, type PoolEntry } from "../multi/pool";
import { roomFailure } from "./roomFailure";

const live = (over: Partial<PoolEntry> = {}): PoolEntry => ({
  ...blankEntry("b", "bravo.k2.dev"),
  reach: "live",
  auth: "ok",
  role: "member",
  boot: { phase: "ready", ready: true, version: "0.45.5", protocol: 1, instanceId: "i", features: [], at: 1 },
  ...over,
});
const base = { saved: true, hasLogin: true, serverLabel: "Bravo", now: 10_000 };

describe("room failure banner", () => {
  it("a healthy or not-yet-checked server shows no banner (MS30: open, check later)", () => {
    expect(roomFailure({ ...base, entry: live() })).toBeNull();
    expect(roomFailure({ ...base, entry: undefined })).toBeNull();
  });

  it("each state: copy and its one action", () => {
    const row = (entry: PoolEntry | undefined, over: Partial<typeof base> = {}) => {
      const f = roomFailure({ ...base, ...over, entry });
      return f && [f.state, f.copy, f.action, f.actionLabel];
    };
    expect(row(live({ reach: "offline", nextAt: 22_000 }))).toEqual([
      "offline",
      "Offline · retrying in 12 s",
      "retry",
      "Retry now",
    ]);
    expect(row(live({ reach: "starting" }))).toEqual(["restarting", "Restarting…", "retry", "Retry now"]);
    expect(row(live(), { hasLogin: false })).toEqual(["signin-required", "Sign in to Bravo", "sign-in", "Sign in"]);
    expect(row(live({ auth: "kicked" }))).toEqual(["kicked", "Removed from Bravo", "sign-in", "Sign in"]);
    expect(row(live({ auth: "rotate-required" }))).toEqual([
      "rotate-required",
      "Change password on Bravo",
      "sign-in",
      "Sign in",
    ]);
    expect(
      row(live({ boot: { ...live().boot!, version: "0.41.5" } }))
    ).toEqual(["too-old", "Bravo needs an update", "switch", "Open"]);
    expect(row(live({ role: "viewer" }))).toEqual(["no-access", "No access on Bravo", null, null]);
    expect(row(live(), { saved: false })).toEqual([
      "removed",
      "Bravo was removed from this phone",
      null,
      null,
    ]);
  });

  it("0.41.6 is the floor (Q9): at the floor the room is usable", () => {
    expect(roomFailure({ ...base, entry: live({ boot: { ...live().boot!, version: "0.41.6" } }) })).toBeNull();
  });
});
