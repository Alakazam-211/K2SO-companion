import { describe, expect, it } from "vitest";
import {
  activityForRow,
  activityRowText,
  countsText,
  parseActivitySnapshot,
} from "./agentActivity";

// Trimmed from a live K2 0.45.3 `GET /cli/activity/snapshot`.
const SNAPSHOT = {
  instanceId: "i",
  seq: 9,
  serverNow: 1,
  staleAfterSecs: 1800,
  rows: [
    {
      sessionId: "main-1",
      agentName: "5333cb83",
      display: "working",
      counts: { subagents: 1, tools: 7, commands: 2 },
      workspacePath: "/w/app",
    },
    {
      sessionId: "side-1",
      agentName: "tab-a",
      display: "waiting",
      counts: { subagents: 0, tools: 3, commands: 1 },
      workspacePath: "/w/app",
    },
    {
      sessionId: "idle-1",
      agentName: "tab-b",
      display: "idle",
      counts: { subagents: 0, tools: 40, commands: 9 },
      workspacePath: "/w/app",
    },
    { sessionId: "old", display: "working", workspacePath: "/w/old" },
  ],
  workspaces: [
    { workspacePath: "/w/app", display: "waiting", counts: { working: 1, waiting: 1, idle: 1 } },
    { workspacePath: "/w/old", display: "working" },
    { workspacePath: "/w/quiet", display: "idle" },
  ],
};

describe("parseActivitySnapshot", () => {
  const snap = parseActivitySnapshot(SNAPSHOT);

  it("sums counts over a workspace's busy sessions only", () => {
    expect(snap.byPath["/w/app"]).toEqual({
      display: "waiting",
      counts: { subagents: 1, tools: 10, commands: 3 },
    });
  });

  it("treats a pre-0.45.2 row without counts as zeros", () => {
    expect(snap.byPath["/w/old"].counts).toEqual({ subagents: 0, tools: 0, commands: 0 });
  });

  it("keys sessions by id", () => {
    expect(snap.bySession["side-1"].display).toBe("waiting");
  });

  it("survives junk", () => {
    expect(parseActivitySnapshot(null)).toEqual({ byPath: {}, bySession: {} });
    expect(parseActivitySnapshot({ rows: "x", workspaces: [null, 3] })).toEqual({
      byPath: {},
      bySession: {},
    });
  });
});

describe("activityForRow", () => {
  const snap = parseActivitySnapshot(SNAPSHOT);

  it("reads the workspace rollup for a main chat, ignoring a trailing slash", () => {
    expect(activityForRow({ path: "/w/app/" }, snap, false)?.display).toBe("waiting");
  });

  it("reads its own session for a sidecar", () => {
    expect(activityForRow({ path: "/w/app", terminalId: "side-1" }, snap, true)?.counts.tools).toBe(3);
    expect(activityForRow({ path: "/w/app", terminalId: null }, snap, true)).toBeNull();
  });

  it("shows nothing for idle work", () => {
    expect(activityForRow({ path: "/w/quiet" }, snap, false)).toBeNull();
    expect(activityForRow({ terminalId: "idle-1" }, snap, true)).toBeNull();
  });
});

describe("row text", () => {
  it("joins the state word and non-zero counts", () => {
    expect(
      activityRowText({ display: "working", counts: { subagents: 2, tools: 14, commands: 5 } })
    ).toBe("Working · 2 subagents · 14 tools · 5 commands");
    expect(activityRowText({ display: "waiting", counts: { subagents: 0, tools: 0, commands: 0 } })).toBe(
      "Needs you"
    );
    expect(countsText({ subagents: 0, tools: 1, commands: 0 })).toBe("1 tool");
    expect(countsText(null)).toBeNull();
  });
});
