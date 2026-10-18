// Row fold table (multi-server S2, MS17/MS18 as amended by MA10–MA12).
// Ported from desktop K2 `src/renderer/lib/home-status.test.ts`
// ("another saved server" and Home 0.43.2 cases), keyed to the phone's
// pool entry. Desktop's `signing-in` from another window's login lease does
// not exist on the phone (NG5); it shows only while the user's own sign-in
// sheet is up. "Same server as" (MS81) and presence chips are not ported.

import { describe, expect, it } from "vitest";
import {
  activityForWorkspace,
  resolveRowStatus,
  rowActivityOf,
  rowFailure,
  type RowStatusInput,
} from "./rowStatus";
import { blankEntry, parsePresenceActivity, type PoolEntry } from "./pool";

function probe(p: Partial<PoolEntry>): PoolEntry {
  return {
    ...blankEntry("b", "b.k2.dev"),
    reach: "live",
    boot: { phase: "ready", ready: true, version: "0.45.3", protocol: 1, instanceId: "i1", features: [], at: 1 },
    auth: "ok",
    role: "member",
    presence: [],
    checkedAt: 1,
    ...p,
  };
}

const base: RowStatusInput = {
  saved: true,
  hasLogin: true,
  entry: undefined,
  serverLabel: "Box B",
  workspaceId: "pb",
};

const kind = (over: Partial<RowStatusInput>) => resolveRowStatus({ ...base, ...over }).kind;

describe("resolveRowStatus — fold order (desktop home-status)", () => {
  it("ready → live", () => {
    const s = resolveRowStatus({ ...base, entry: probe({}) });
    expect([s.kind, s.label]).toEqual(["live", "Live"]);
  });

  it("unreachable / not ready → offline", () => {
    expect(kind({ entry: probe({ reach: "offline", presence: null }) })).toBe("offline");
  });

  it("no login held → Sign in instead of offline, even with no probe", () => {
    const s = resolveRowStatus({ ...base, hasLogin: false, entry: undefined });
    expect([s.kind, s.label]).toEqual(["sign-in", "Sign in"]);
    expect(kind({ hasLogin: false, entry: probe({ reach: "offline" }) })).toBe("sign-in");
  });

  it("the server refused the saved login → Sign in", () => {
    expect(kind({ entry: probe({ auth: "signin-required", presence: null }) })).toBe("sign-in");
  });

  it("kicked / new password → Sign in, with the reason as the detail", () => {
    const kicked = resolveRowStatus({ ...base, entry: probe({ auth: "kicked" }) });
    expect(kicked.kind).toBe("sign-in");
    expect(kicked.detail).toBe("Removed from Box B. Sign in again.");
    const rotate = resolveRowStatus({ ...base, entry: probe({ auth: "rotate-required" }) });
    expect(rotate.kind).toBe("sign-in");
    expect(rotate.detail).toBe("Box B needs a new password.");
    const noted = resolveRowStatus({
      ...base,
      hasLogin: false,
      entry: probe({ auth: "signin-required", authNote: "Signed out of Box B." }),
    });
    expect(noted.kind).toBe("sign-in");
    expect(noted.detail).toBe("Signed out of Box B.");
  });

  it("signing-in only while the user's own sign-in sheet is up (NG5)", () => {
    expect(kind({ hasLogin: false, signingIn: true })).toBe("signing-in");
    expect(kind({ entry: probe({ auth: "signin-required" }), signingIn: true })).toBe("signing-in");
    expect(resolveRowStatus({ ...base, hasLogin: false, signingIn: true }).label).toBe("Signing in…");
    // A good login is not "signing in" because a sheet happens to be open.
    expect(kind({ entry: probe({}), signingIn: true })).toBe("live");
  });

  it("restarting (not ready yet) → Starting", () => {
    const s = resolveRowStatus({ ...base, entry: probe({ reach: "starting" }) });
    expect([s.kind, s.label]).toEqual(["starting", "Starting"]);
  });

  it("MS83: a role below Member, or one this app does not know, → No access", () => {
    for (const role of ["viewer", "auditor", ""]) {
      const s = resolveRowStatus({ ...base, entry: probe({ role }) });
      expect([role, s.kind]).toEqual([role, "no-access"]);
      expect(s.label).toBe("No access");
    }
    for (const role of ["owner", "admin", "member"]) {
      expect([role, kind({ entry: probe({ role }) })]).toEqual([role, "live"]);
    }
    // MA10: not read (an older server without whoami) is allowed.
    expect(kind({ entry: probe({ role: null }) })).toBe("live");
  });

  it("not probed yet → checking; not a saved server → offline", () => {
    expect(kind({ entry: undefined })).toBe("checking");
    expect(kind({ entry: probe({ reach: "unknown" }) })).toBe("checking");
    expect(kind({ saved: false, entry: undefined })).toBe("offline");
    // Not saved beats everything, even no login.
    expect(kind({ saved: false, hasLogin: false })).toBe("offline");
  });

  it("live on an older server with no summary → live", () => {
    expect(kind({ entry: probe({ presence: null, activity: null }) })).toBe("live");
  });

  it("Q9: a known version below 0.41.6 → too-old; unknown version is not", () => {
    const old = probe({ boot: { ...probe({}).boot!, version: "0.41.5" } });
    expect(kind({ entry: old })).toBe("too-old");
    expect(kind({ entry: probe({ boot: { ...probe({}).boot!, version: "0.41.6" } }) })).toBe("live");
    expect(kind({ entry: probe({ boot: { ...probe({}).boot!, version: null } }) })).toBe("live");
    // Order: offline / starting win over too-old; too-old wins over auth.
    expect(kind({ entry: { ...old, reach: "offline" } })).toBe("offline");
    expect(kind({ entry: { ...old, auth: "signin-required" } })).toBe("too-old");
  });
});

describe("what an agent on another server is doing (MS18, MA12)", () => {
  it("a closed row reads the server's summary: Working, Needs you, else Live", () => {
    const working = resolveRowStatus({
      ...base,
      entry: probe({ activity: [{ workspaceId: "pb", status: "working" }] }),
    });
    expect([working.kind, working.label]).toEqual(["working", "Working"]);
    const waiting = resolveRowStatus({
      ...base,
      entry: probe({ activity: [{ workspaceId: "pb", status: "permission" }] }),
    });
    expect([waiting.kind, waiting.label]).toEqual(["permission", "Needs you"]);
    // Another workspace busy on the same server: this row stays Live.
    expect(kind({ entry: probe({ activity: [{ workspaceId: "pz", status: "working" }] }) })).toBe("live");
    expect(kind({ entry: probe({ activity: null }) })).toBe("live");
  });

  it("a row with no workspace id gets no dots", () => {
    expect(
      kind({ workspaceId: null, entry: probe({ activity: [{ workspaceId: "pb", status: "working" }] }) })
    ).toBe("live");
  });

  it("the open room's (or 5 s snapshot's) activity wins over a stale summary, both ways", () => {
    const stale = probe({ activity: [{ workspaceId: "pb", status: "working" }] });
    expect(kind({ entry: stale, roomActivity: "idle" })).toBe("live");
    expect(kind({ entry: probe({}), roomActivity: "permission" })).toBe("permission");
    expect(kind({ entry: probe({}), roomActivity: "working" })).toBe("working");
    expect(kind({ entry: stale, roomActivity: null })).toBe("working");
  });

  it("activity never paints over offline, sign-in or no access", () => {
    const busy = [{ workspaceId: "pb", status: "working" as const }];
    expect(kind({ entry: probe({ reach: "offline", activity: busy }) })).toBe("offline");
    expect(kind({ entry: probe({ auth: "kicked", activity: busy }) })).toBe("sign-in");
    expect(kind({ entry: probe({ role: "viewer", activity: busy }), roomActivity: "working" })).toBe("no-access");
  });

  it("display beats status; waiting reads as Needs you; unverifiable as No update", () => {
    const parsed = parsePresenceActivity([
      { workspaceId: "pb", status: "working", display: "monitoring" },
      { workspaceId: "pc", status: "idle", display: "unverifiable" },
      { workspaceId: "pd", status: "permission", display: "waiting" },
      { workspaceId: "pe", status: "working" },
      { workspaceId: "pf", status: "idle" },
      { workspaceId: "", status: "working" },
      null,
    ]);
    expect(parsed!.map((a) => [a.workspaceId, a.display ?? null])).toEqual([
      ["pb", "monitoring"],
      ["pc", "unverifiable"],
      ["pd", "waiting"],
      ["pe", null],
    ]);
    expect(activityForWorkspace(parsed, "pb")).toBe("monitoring");
    expect(activityForWorkspace(parsed, "pd")).toBe("permission");
    expect(activityForWorkspace(parsed, "pe")).toBe("working");
    expect(activityForWorkspace(parsed, null)).toBe(null);
    expect(activityForWorkspace(null, "pb")).toBe(null);
    const mon = resolveRowStatus({ ...base, entry: probe({ activity: parsed }) });
    expect([mon.kind, mon.label]).toEqual(["monitoring", "Monitoring"]);
    const stale = resolveRowStatus({ ...base, workspaceId: "pc", entry: probe({ activity: parsed }) });
    expect([stale.kind, stale.label]).toEqual(["unverifiable", "No update"]);
  });

  it("summary activity carries no counts: the list shows the dot and the word only", () => {
    const a = rowActivityOf(resolveRowStatus({ ...base, roomActivity: "permission", entry: probe({}) }));
    expect(a).toEqual({ display: "waiting", counts: { subagents: 0, tools: 0, commands: 0 } });
    expect(rowActivityOf(resolveRowStatus({ ...base, entry: probe({}) }))).toBe(null);
    expect(rowActivityOf({ kind: "unverifiable", label: "No update" })).toBe(null);
  });
});

describe("failure rows (MS35 copy table): exactly one action each", () => {
  const now = 100_000;
  const fail = (over: Partial<RowStatusInput>) => {
    const input = { ...base, ...over };
    return rowFailure(resolveRowStatus(input), input.entry, "Box B", now);
  };

  it("maps every failure state to its copy and at most one action", () => {
    const table: [Partial<RowStatusInput>, string, string, string | null][] = [
      [{ entry: undefined }, "checking", "Checking…", null],
      [{ entry: probe({ reach: "offline", nextAt: now + 12_000 }) }, "offline", "Reconnecting…", "retry"],
      [{ entry: probe({ reach: "starting" }) }, "restarting", "Restarting…", "retry"],
      [{ hasLogin: false }, "signin-required", "Sign in to Box B", "sign-in"],
      // The phone holds a login the server no longer takes: sign in AGAIN.
      [{ entry: probe({ auth: "signin-required" }) }, "signin-required", "Sign in again to Box B", "sign-in"],
      [{ entry: probe({ auth: "kicked" }) }, "kicked", "Removed from Box B", "sign-in"],
      [{ entry: probe({ auth: "rotate-required" }) }, "rotate-required", "Change password on Box B", "sign-in"],
      [{ entry: probe({ boot: { ...probe({}).boot!, version: "0.40.0" } }) }, "too-old", "Box B needs an update", "switch"],
      [{ entry: probe({ role: "viewer" }) }, "no-access", "No access on Box B", null],
      [{ hasLogin: false, signingIn: true }, "signing-in", "Signing in…", null],
    ];
    for (const [over, state, copy, action] of table) {
      const f = fail(over);
      expect([state, f?.state, f?.copy, f?.action ?? null]).toEqual([state, state, copy, action]);
      expect(f?.actionLabel === null).toBe(action === null);
    }
  });

  it("a healthy server has no failure", () => {
    expect(fail({ entry: probe({}) })).toBe(null);
    expect(fail({ entry: probe({ activity: [{ workspaceId: "pb", status: "working" }] }) })).toBe(null);
  });

  it("an offline row says it is reconnecting, whenever the next check is", () => {
    expect(fail({ entry: probe({ reach: "offline", nextAt: now - 5 }) })?.copy).toBe("Reconnecting…");
    expect(fail({ entry: probe({ reach: "offline", nextAt: null }) })?.copy).toBe("Reconnecting…");
  });

  it("an expired login says Sign in again; no login at all says Sign in", () => {
    expect(fail({ entry: probe({ auth: "signin-required" }) })?.actionLabel).toBe("Sign in again");
    expect(fail({ hasLogin: false })?.actionLabel).toBe("Sign in");
    expect(fail({ entry: probe({ auth: "kicked" }) })?.actionLabel).toBe("Sign in");
  });
});
