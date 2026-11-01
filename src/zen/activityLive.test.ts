import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetActivityLiveForTests,
  activityMirrorBody,
  applyActivityFrame,
  isActivityChangedFrame,
  seedActivityMirror,
} from "./activityLive";

const SNAP = {
  instanceId: "i1",
  seq: 5,
  staleAfterSecs: 60,
  rows: [
    { sessionId: "a", display: "working", workspacePath: "/w" },
    { sessionId: "b", display: "idle", workspacePath: "/w" },
  ],
  workspaces: [{ workspacePath: "/w", display: "working" }],
};

beforeEach(() => __resetActivityLiveForTests());

describe("activity mirror (speed PRD A2)", () => {
  it("needs a snapshot with a seq before frames can follow on", () => {
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 1 })).toBe("resync");
    expect(seedActivityMirror("s", { rows: [] })).toBe(false); // an older daemon: no seq
    expect(seedActivityMirror("s", SNAP)).toBe(true);
  });

  it("applies rows and rollups in seq order; a removal asks for a re-read", () => {
    seedActivityMirror("s", SNAP);
    expect(isActivityChangedFrame({ kind: "activity_changed" })).toBe(true);
    expect(
      applyActivityFrame("s", {
        kind: "activity_changed",
        seq: 6,
        instanceId: "i1",
        row: { sessionId: "a", display: "idle", workspacePath: "/w" },
        workspace: { workspacePath: "/w", display: "idle" },
      })
    ).toBe("applied");
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 7, instanceId: "i1", removed: "b" })).toBe(
      "applied-resync"
    );
    // K2 0.46.8: a removal with every rollup (`workspaces`) is complete.
    expect(
      applyActivityFrame("s", {
        kind: "activity_changed",
        seq: 8,
        instanceId: "i1",
        removed: "zz",
        workspace: null,
        workspaces: [{ workspacePath: "/w", display: "idle" }],
      })
    ).toBe("applied");
    expect(
      applyActivityFrame("s", {
        kind: "activity_changed",
        seq: 9,
        instanceId: "i1",
        removed: "zz",
        workspace: { workspacePath: "/w", display: "idle" },
      })
    ).toBe("applied");
    const body = activityMirrorBody("s")!;
    expect(body.seq).toBe(9);
    expect(body.rows).toEqual([{ sessionId: "a", display: "idle", workspacePath: "/w" }]);
    expect(body.workspaces).toEqual([{ workspacePath: "/w", display: "idle" }]);
    expect(body.staleAfterSecs).toBe(60);
  });

  it("snapshot rows without a sessionId stay in the mirror (they count in the totals)", () => {
    seedActivityMirror("s", { ...SNAP, rows: [...SNAP.rows, { display: "working", workspacePath: "/w", counts: { tools: 2 } }] });
    expect((activityMirrorBody("s")!.rows as unknown[]).length).toBe(3);
  });

  it("old frames are ignored; gaps and another daemon instance resync", () => {
    seedActivityMirror("s", SNAP);
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 5, instanceId: "i1" })).toBe("old");
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 7, instanceId: "i1" })).toBe("resync");
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 6, instanceId: "i2" })).toBe("resync");
  });
});
