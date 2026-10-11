import { describe, expect, it } from "vitest";
import { harnessOfSession, normalizeHarness } from "./llmHarness";

describe("normalizeHarness", () => {
  it("takes the binary name of a command", () => {
    expect(normalizeHarness("claude")).toBe("claude");
    expect(normalizeHarness("/opt/homebrew/bin/codex --full-auto")).toBe("codex");
    expect(normalizeHarness("  Grok  ")).toBe("grok");
    expect(normalizeHarness("cursor-agent")).toBe("cursor");
  });

  it("is null for shells and junk", () => {
    expect(normalizeHarness("zsh")).toBeNull();
    expect(normalizeHarness("-zsh")).toBeNull();
    expect(normalizeHarness("/bin/bash -l")).toBeNull();
    expect(normalizeHarness("")).toBeNull();
    expect(normalizeHarness(null)).toBeNull();
    expect(normalizeHarness(42)).toBeNull();
  });
});

describe("harnessOfSession", () => {
  const counts = { subagents: 0, tools: 0, commands: 0 };
  it("prefers the session command", () => {
    expect(
      harnessOfSession({ command: "grok", terminalId: "t1" }, { t1: { display: "idle", counts, harness: "claude" } })
    ).toBe("grok");
  });

  it("falls back to the activity snapshot harness for the same PTY", () => {
    expect(
      harnessOfSession({ command: null, terminalId: "t1" }, { t1: { display: "idle", counts, harness: "gemini" } })
    ).toBe("gemini");
  });

  it("is null when nothing names an LLM", () => {
    expect(harnessOfSession({ command: "zsh", terminalId: "t2" }, {})).toBeNull();
    expect(harnessOfSession(undefined)).toBeNull();
  });
});
