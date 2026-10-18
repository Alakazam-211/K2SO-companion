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
    // Down for longer than the 10 s grace: offline, and still trying.
    expect(row(live({ reach: "offline", nextAt: 22_000 }))).toEqual([
      "offline",
      "Bravo is offline. We'll keep trying",
      "retry",
      "Retry now",
    ]);
    expect(row(live({ reach: "starting" }))).toEqual(["restarting", "Bravo is restarting…", "retry", "Retry now"]);
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

  it("down: 'Reconnecting…' (spinner, no action) for 10 s after it went down or the user's last try, then offline", () => {
    const off = live({ reach: "offline", checkedAt: 9_000 });
    const at = (now: number, over: Partial<Parameters<typeof roomFailure>[0]> = {}) =>
      roomFailure({ ...base, entry: off, now, downSince: 5_000, ...over });
    expect(at(10_000)).toMatchObject({
      state: "reconnecting",
      copy: "Reconnecting to Bravo…",
      action: null,
      spinner: true,
      queuesInput: true,
    });
    expect(at(15_000)).toMatchObject({
      state: "offline",
      copy: "Bravo is offline. We'll keep trying",
      action: "retry",
      actionLabel: "Retry now",
      queuesInput: true,
    });
    // Retry now (or opening the chat) restarts the grace.
    expect(at(15_000, { retryAt: 14_000 })?.state).toBe("reconnecting");
    // A reconnect running reads as reconnecting.
    expect(at(60_000, { reconnecting: true })?.state).toBe("reconnecting");
  });

  it("the active server: a banner only when it is down or its login expired", () => {
    const active = { ...base, active: true, entry: { ...live(), auth: "signin-required" as const } };
    expect(roomFailure({ ...active })).toBeNull();
    expect(roomFailure({ ...active, downSince: 9_500 })?.state).toBe("reconnecting");
    expect(roomFailure({ ...active, expired: true })).toMatchObject({
      state: "signin-required",
      copy: "Sign in again to Bravo",
      action: "sign-in",
      actionLabel: "Sign in again",
    });
    expect(roomFailure({ ...active, hasLogin: false, downSince: 1 })).toBeNull();
  });

  it("an expired login on another server says Sign in again, input off", () => {
    const f = roomFailure({ ...base, entry: live({ auth: "signin-required" }) });
    expect(f).toMatchObject({ state: "signin-required", copy: "Sign in again to Bravo", actionLabel: "Sign in again" });
    expect(f?.queuesInput).toBeFalsy();
  });

  it("0.41.6 is the floor (Q9): at the floor the room is usable", () => {
    expect(roomFailure({ ...base, entry: live({ boot: { ...live().boot!, version: "0.41.6" } }) })).toBeNull();
  });
});
