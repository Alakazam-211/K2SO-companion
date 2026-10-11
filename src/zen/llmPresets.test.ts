import { describe, expect, it } from "vitest";
import { canSidecar, emojiByHarness, parseActiveLlms, parseCommandLine } from "./llmPresets";

describe("parseCommandLine", () => {
  it("splits program and args, honoring quotes", () => {
    expect(parseCommandLine("claude --dangerously-skip-permissions")).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions"],
    });
    expect(parseCommandLine("ollama run llama3.2")).toEqual({ command: "ollama", args: ["run", "llama3.2"] });
    expect(parseCommandLine(`foo --msg "a b" 'c d'`)).toEqual({ command: "foo", args: ["--msg", "a b", "c d"] });
    expect(parseCommandLine("")).toEqual({ command: "", args: [] });
  });
});

describe("parseActiveLlms", () => {
  it("maps GET /cli/companion/presets rows", () => {
    const out = parseActiveLlms([
      { id: "a", name: "Cursor Agent", command: "cursor-agent", icon: "" },
      { id: "b", name: "CG", command: "clawg", icon: "🦀" },
    ]);
    expect(out).toEqual([
      {
        id: "a",
        name: "Cursor Agent",
        commandLine: "cursor-agent",
        command: "cursor-agent",
        args: [],
        harness: "cursor",
        emoji: null,
      },
      { id: "b", name: "CG", commandLine: "clawg", command: "clawg", args: [], harness: "clawg", emoji: "🦀" },
    ]);
    expect(emojiByHarness(out)).toEqual({ clawg: "🦀" });
  });

  it("drops disabled, duplicate and command-less rows", () => {
    const out = parseActiveLlms([
      { id: "a", label: "Claude", command: "claude", enabled: 1 },
      { id: "a", name: "Claude again", command: "claude" },
      { id: "b", name: "Off", command: "gemini", enabled: 0 },
      { id: "c", name: "Empty", command: "  " },
      null,
    ]);
    expect(out?.map((l) => [l.id, l.name])).toEqual([["a", "Claude"]]);
  });

  it("is null for an unrecognised body", () => {
    expect(parseActiveLlms({ error: "route not found" })).toBeNull();
    expect(parseActiveLlms(undefined)).toBeNull();
    expect(parseActiveLlms([])).toEqual([]);
  });
});

describe("canSidecar", () => {
  it("is true only for daemon provider harnesses", () => {
    for (const h of ["claude", "codex", "gemini", "grok", "cursor", "pi", "hermes"]) expect(canSidecar(h)).toBe(true);
    for (const h of ["aider", "opencode", "goose", "ollama", "copilot", "clawg", null]) expect(canSidecar(h)).toBe(false);
  });
});
