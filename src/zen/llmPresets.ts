import { normalizeHarness } from "./llmHarness";

/** An LLM the server has switched on (an enabled agent preset). */
export type ActiveLlm = {
  id: string;
  name: string;
  /** Full launch line, as the preset stores it (`codex --yolo`). */
  commandLine: string;
  command: string;
  args: string[];
  /** Normalized harness id (`cursor-agent` → `cursor`). */
  harness: string | null;
  /** A custom preset's emoji; built-ins send "". */
  emoji: string | null;
};

/** Harnesses the daemon can host as an overlay sidecar (`ws/N` address):
 *  K2 `provider_resume.rs` PROVIDERS. Others run as a plain tab. */
export const SIDECAR_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "gemini",
  "grok",
  "cursor",
  "pi",
  "hermes",
]);

export function canSidecar(harness: string | null | undefined): boolean {
  return !!harness && SIDECAR_HARNESSES.has(harness);
}

/** Split a preset launch line into program + args. Honors simple single
 *  and double quotes (desktop `parseCommand`). */
export function parseCommandLine(line: string): { command: string; args: string[] } {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line || "")) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
  }
  const [command = "", ...args] = out;
  return { command, args };
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** GET /cli/companion/presets body → active LLMs. That route already
 *  filters `enabled = 1`; a row that still says `enabled: 0` (the
 *  `/cli/presets/list` shape) is dropped too. Null = unrecognised body. */
export function parseActiveLlms(data: unknown): ActiveLlm[] | null {
  if (!Array.isArray(data)) return null;
  const out: ActiveLlm[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.enabled === 0 || r.enabled === false) continue;
    const id = text(r.id);
    const commandLine = text(r.command);
    const name = text(r.name) || text(r.label);
    if (!id || !commandLine || seen.has(id)) continue;
    const { command, args } = parseCommandLine(commandLine);
    if (!command) continue;
    seen.add(id);
    const emoji = text(r.icon);
    out.push({
      id,
      name: name || command,
      commandLine,
      command,
      args,
      harness: normalizeHarness(command),
      emoji: emoji || null,
    });
  }
  return out;
}

/** Custom presets' emoji by program, so a row running `clawg` can show 🦀
 *  when there is no vendored mark. */
export function emojiByHarness(llms: ActiveLlm[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of llms ?? []) if (l.harness && l.emoji && !out[l.harness]) out[l.harness] = l.emoji;
  return out;
}
