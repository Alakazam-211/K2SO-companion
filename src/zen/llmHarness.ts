import type { SessionActivity } from "./agentActivity";

/** Shells: a PTY running one of these is a plain terminal, not an LLM. */
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "login"]);

/** Binary / CLI names that are another name for a known harness id. */
const ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  "gemini-cli": "gemini",
  "grok-cli": "grok",
  "codex-cli": "codex",
  "hermes-agent": "hermes",
  "open-code": "opencode",
  "copilot-cli": "copilot",
};

/** Harness id for a raw command or harness string: `"/opt/bin/claude --x"`
 *  → `claude`. Shells and empty values are null (plain terminal). */
export function normalizeHarness(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().split(/\s+/)[0] || "";
  // `-zsh` is a login shell.
  const base = (first.split("/").pop() || "")
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/^-/, "");
  if (!base || SHELLS.has(base)) return null;
  return ALIASES[base] ?? base;
}

/** A drawer row's harness: the session's `command` (GET
 *  /cli/companion/sessions), else the activity snapshot's `harness` for
 *  the same PTY (`sessionId` = `terminalId`). Null = plain shell. */
export function harnessOfSession(
  session: { command?: unknown; terminalId?: unknown } | null | undefined,
  bySession?: Record<string, SessionActivity>
): string | null {
  const fromCommand = normalizeHarness(session?.command);
  if (fromCommand) return fromCommand;
  const tid = typeof session?.terminalId === "string" ? session.terminalId : "";
  return tid && bySession ? normalizeHarness(bySession[tid]?.harness) : null;
}
