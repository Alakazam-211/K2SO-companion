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
    const body = activityMirrorBody("s")!;
    expect(body.seq).toBe(7);
    expect(body.rows).toEqual([{ sessionId: "a", display: "idle", workspacePath: "/w" }]);
    expect(body.workspaces).toEqual([{ workspacePath: "/w", display: "idle" }]);
    expect(body.staleAfterSecs).toBe(60);
  });

  it("old frames are ignored; gaps and another daemon instance resync", () => {
    seedActivityMirror("s", SNAP);
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 5, instanceId: "i1" })).toBe("old");
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 7, instanceId: "i1" })).toBe("resync");
    expect(applyActivityFrame("s", { kind: "activity_changed", seq: 6, instanceId: "i2" })).toBe("resync");
  });
});
