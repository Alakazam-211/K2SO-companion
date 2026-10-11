import { describe, expect, it, vi } from "vitest";
import {
  canResume,
  liveThreadAddrFor,
  resumeLaunch,
  wakeHistoryRow,
  wakePlanFor,
  type WakeDeps,
} from "./historyWake";
import type { ActiveLlm } from "./llmPresets";
import type { HistoryRow, LiveWorkspaceSession } from "./sessionHistory";

const ID = "0a0b0c0d-0000-4000-8000-000000000002";

function llm(id: string, command: string, args: string[], harness: string): ActiveLlm {
  return { id, name: id, commandLine: [command, ...args].join(" "), command, args, harness, emoji: null };
}
const LLMS = [
  llm("claude", "claude", ["--dangerously-skip-permissions"], "claude"),
  llm("codex", "codex", ["--yolo"], "codex"),
];

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return { addr: ID, title: "Planning", label: null, harness: "claude", at: null, conversationId: ID, ...over };
}

function live(over: Partial<LiveWorkspaceSession> = {}): LiveWorkspaceSession {
  return { sessionId: "t-new", kind: "other", handle: "", conversationId: ID, command: "claude", ...over };
}

describe("resumeLaunch (desktop PROVIDER_CONFIG grammar)", () => {
  it("flag style appends <flag> <id> after the preset's args", () => {
    expect(resumeLaunch("claude", ID, LLMS)).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "--resume", ID],
    });
  });
  it("codex resumes as a subcommand after its global flags", () => {
    expect(resumeLaunch("codex", ID, LLMS)).toEqual({ command: "codex", args: ["--yolo", "resume", ID] });
  });
  it("pi uses --session, cursor runs cursor-agent, without a preset", () => {
    expect(resumeLaunch("pi", ID, [])).toEqual({ command: "pi", args: ["--session", ID] });
    expect(resumeLaunch("cursor", ID, null)).toEqual({ command: "cursor-agent", args: ["--resume", ID] });
    // Desktop adds no flags when no preset is enabled for the provider.
    expect(resumeLaunch("claude", ID, [])).toEqual({ command: "claude", args: ["--resume", ID] });
  });
  it("strips session flags a preset carries and keeps the provider's program", () => {
    const pi = [llm("pi", "/opt/bin/pi", ["--resume", "--model", "x"], "pi")];
    expect(resumeLaunch("pi", ID, pi)).toEqual({ command: "pi", args: ["--model", "x", "--session", ID] });
  });
  it("an unknown CLI or a plain shell cannot resume", () => {
    expect(resumeLaunch("aider", ID, LLMS)).toBeNull();
    expect(resumeLaunch(null, ID, LLMS)).toBeNull();
    expect(resumeLaunch("claude", "", LLMS)).toBeNull();
    expect(canResume("opencode")).toBe(false);
    expect(canResume("toString")).toBe(false);
    expect(canResume("hermes")).toBe(true);
  });
});

describe("wakePlanFor", () => {
  it("a remembered ws/handle sidecar wakes through its host respawn", () => {
    expect(wakePlanFor(row({ addr: "k2/old", harness: "grok" }), LLMS)).toEqual({ kind: "sidecar" });
  });
  it("a conversation resumes with its harness", () => {
    expect(wakePlanFor(row(), LLMS)).toEqual({
      kind: "resume",
      conversationId: ID,
      launch: { command: "claude", args: ["--dangerously-skip-permissions", "--resume", ID] },
    });
  });
  it("unknown harness is read-only", () => {
    expect(wakePlanFor(row({ harness: "aider" }), LLMS)).toEqual({ kind: "readonly" });
    expect(wakePlanFor(row({ harness: null }), LLMS)).toEqual({ kind: "readonly" });
  });
});

describe("liveThreadAddrFor", () => {
  it("a plain woken tab keeps the conversation id", () => {
    expect(liveThreadAddrFor([live()], ID)).toBe(ID);
  });
  it("follows a moved Thread to the tab's ws/N handle", () => {
    expect(liveThreadAddrFor([live({ kind: "sidecar", handle: "k2/4" })], ID)).toBe("k2/4");
  });
  it("matches the spawned session id before the conversation is detected", () => {
    expect(liveThreadAddrFor([live({ conversationId: null, kind: "sidecar", handle: "k2/5" })], ID, "t-new")).toBe("k2/5");
    expect(liveThreadAddrFor([], ID, "t-new")).toBeNull();
  });
});

function deps(over: Partial<WakeDeps> = {}): WakeDeps {
  return {
    listLive: vi.fn(async () => []),
    spawnTab: vi.fn(async () => ({ ok: true, sessionId: "t-new" })),
    ensureSidecar: vi.fn(async () => ({ ok: true, terminalId: "t-side" })),
    refreshSessions: vi.fn(async () => {}),
    ...over,
  };
}

describe("wakeHistoryRow", () => {
  it("spawns the resume launch in the workspace and resolves the new Thread addr", async () => {
    const d = deps({
      listLive: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([live({ kind: "sidecar", handle: "k2/4" })]),
    });
    const r = await wakeHistoryRow({ row: row(), path: "/ws", llms: LLMS, sidecarLaunch: null }, d);
    expect(d.spawnTab).toHaveBeenCalledWith(
      "/ws",
      { command: "claude", args: ["--dangerously-skip-permissions", "--resume", ID] },
      "Planning"
    );
    expect(d.refreshSessions).toHaveBeenCalled();
    expect(r).toEqual({ ok: true, addr: "k2/4", terminalId: "t-new", already: false });
  });
  it("falls back to the conversation id when the refresh does not list it yet", async () => {
    const r = await wakeHistoryRow({ row: row(), path: "/ws", llms: LLMS, sidecarLaunch: null }, deps());
    expect(r).toEqual({ ok: true, addr: ID, terminalId: "t-new", already: false });
  });
  it("an already-live conversation is opened, not spawned", async () => {
    const d = deps({ listLive: vi.fn(async () => [live({ sessionId: "t-live" })]) });
    const r = await wakeHistoryRow({ row: row(), path: "/ws", llms: LLMS, sidecarLaunch: null }, d);
    expect(d.spawnTab).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, addr: ID, terminalId: "t-live", already: true });
  });
  it("reports a spawn failure or a throw", async () => {
    const refused = await wakeHistoryRow(
      { row: row(), path: "/ws", llms: LLMS, sidecarLaunch: null },
      deps({ spawnTab: vi.fn(async () => ({ ok: false, error: "nope" })) })
    );
    expect(refused).toEqual({ ok: false, error: "nope" });
    const thrown = await wakeHistoryRow(
      { row: row(), path: "/ws", llms: LLMS, sidecarLaunch: null },
      deps({ spawnTab: vi.fn(async () => Promise.reject(new Error("offline"))) })
    );
    expect(thrown).toEqual({ ok: false, error: "offline" });
  });
  it("a remembered sidecar goes through ensureSidecar with its stored harness", async () => {
    const d = deps();
    const launch = { command: "grok", args: [] };
    const r = await wakeHistoryRow(
      { row: row({ addr: "k2/old", title: "k2/old", label: "Old reviewer", harness: "grok" }), path: "/ws", llms: LLMS, sidecarLaunch: launch },
      d
    );
    expect(d.ensureSidecar).toHaveBeenCalledWith({ path: "/ws", addr: "k2/old", chatTitle: "Old reviewer", launch });
    expect(d.spawnTab).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, addr: "k2/old", terminalId: "t-side", already: false });
  });
});
