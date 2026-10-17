import { describe, expect, it } from "vitest";
import {
  activityForRow,
  activityRowText,
  chatSessionsOf,
  countsText,
  harnessForRow,
  parseActivitySnapshot,
  sameActivity,
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
  // GET /cli/companion/sessions: terminalId = activity sessionId.
  const sessions = chatSessionsOf([
    { terminalId: "main-1", isMainChat: true, cwd: "/w/app/" },
    { terminalId: "side-1", isMainChat: false, cwd: "/w/app" },
    { terminalId: "idle-1", isMainChat: false, cwd: "/w/app" },
  ]);

  it("reads only the main session for a main chat, ignoring a trailing slash", () => {
    expect(activityForRow({ path: "/w/app/" }, snap, false, sessions)).toEqual({
      display: "working",
      counts: { subagents: 1, tools: 7, commands: 2 },
    });
  });

  it("falls back to the workspace minus known non-main sessions", () => {
    const sidecarOnly = chatSessionsOf([{ terminalId: "side-1", isMainChat: false, cwd: "/w/app" }]);
    expect(activityForRow({ path: "/w/app" }, snap, false, sidecarOnly)?.display).toBe("working");
    // A main PTY restarted under a new id: the stale id is not in the snapshot.
    const stale = chatSessionsOf([
      { terminalId: "gone", isMainChat: true, cwd: "/w/app" },
      { terminalId: "side-1", isMainChat: false, cwd: "/w/app" },
    ]);
    expect(activityForRow({ path: "/w/app" }, snap, false, stale)?.counts.tools).toBe(7);
  });

  it("is not lit by a sidecar when the main chat is idle", () => {
    const quietMain = parseActivitySnapshot({
      rows: [
        { sessionId: "main-1", agentName: "p", display: "idle", workspacePath: "/w/app" },
        { sessionId: "side-1", agentName: "1", display: "working", workspacePath: "/w/app" },
      ],
      workspaces: [{ workspacePath: "/w/app", display: "working" }],
    });
    expect(activityForRow({ path: "/w/app" }, quietMain, false, sessions)).toBeNull();
  });

  it("reads its own session for a sidecar", () => {
    expect(activityForRow({ path: "/w/app", terminalId: "side-1" }, snap, true)?.counts.tools).toBe(3);
    expect(activityForRow({ path: "/w/app", terminalId: null }, snap, true)).toBeNull();
  });

  it("finds a sidecar without a terminalId by its addr suffix", () => {
    const live = parseActivitySnapshot({
      rows: [
        { sessionId: "p-main", agentName: "uuid", display: "working", workspacePath: "/w/app" },
        { sessionId: "p-side", agentName: "reviewer", display: "waiting", workspacePath: "/w/app" },
        { sessionId: "q-side", agentName: "reviewer", display: "working", workspacePath: "/w/other" },
      ],
    });
    const row = { path: "/w/app", addr: "app/reviewer", terminalId: null };
    expect(activityForRow(row, live, true)?.display).toBe("waiting");
    expect(activityForRow({ ...row, addr: "app/2" }, live, true)).toBeNull();
  });

  it("shows nothing for idle work", () => {
    expect(activityForRow({ path: "/w/quiet" }, snap, false)).toBeNull();
    expect(activityForRow({ terminalId: "idle-1" }, snap, true)).toBeNull();
  });
});

describe("sameActivity", () => {
  it("is true for an equal re-parse and false when a count moves", () => {
    const a = parseActivitySnapshot(SNAPSHOT);
    expect(sameActivity(a, parseActivitySnapshot(SNAPSHOT))).toBe(true);
    const moved = structuredClone(SNAPSHOT);
    moved.rows[0].counts = { subagents: 1, tools: 8, commands: 2 };
    expect(sameActivity(a, parseActivitySnapshot(moved))).toBe(false);
    expect(sameActivity(a, parseActivitySnapshot({ rows: [], workspaces: [] }))).toBe(false);
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

describe("harnessForRow", () => {
  const snap = parseActivitySnapshot({
    rows: [
      { sessionId: "m", agentName: "a", display: "idle", workspacePath: "/w/app", harness: "codex" },
      { sessionId: "s", agentName: "tab-a", display: "working", workspacePath: "/w/app", harness: "grok" },
      { sessionId: "x", agentName: "b", display: "idle", workspacePath: "/w/two", harness: "claude" },
      { sessionId: "y", agentName: "c", display: "idle", workspacePath: "/w/two", harness: "gemini" },
    ],
  });
  const sessions = chatSessionsOf([
    { terminalId: "m", isMainChat: true, cwd: "/w/app" },
    { terminalId: "s", isMainChat: false, cwd: "/w/app" },
  ]);

  it("reads the main chat's session even when idle", () => {
    expect(harnessForRow({ path: "/w/app/" }, snap, false, sessions)).toBe("codex");
  });

  it("reads a sidecar by its addr suffix", () => {
    expect(harnessForRow({ path: "/w/app", addr: "app/tab-a" }, snap, true, sessions)).toBe("grok");
  });

  it("is null when the workspace's sessions disagree or are missing", () => {
    expect(harnessForRow({ path: "/w/two" }, snap, false)).toBeNull();
    expect(harnessForRow({ path: "/w/none" }, snap, false)).toBeNull();
  });
});
