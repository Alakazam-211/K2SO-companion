/** LLM / harness marks, vendored from desktop K2
 *  (`src/renderer/assets/llm-icons`, mostly Lobe Icons, MIT). See
 *  `src/assets/llm/NOTICE.md`. Inlined `?raw` so the monochrome marks'
 *  `currentColor` follows the row's text colour, as desktop's AgentIcon. */
import aiderSvg from "../assets/llm/aider.svg?raw";
import claudeSvg from "../assets/llm/claude.svg?raw";
import codexSvg from "../assets/llm/codex.svg?raw";
import copilotSvg from "../assets/llm/copilot.svg?raw";
import cursorSvg from "../assets/llm/cursor.svg?raw";
import geminiSvg from "../assets/llm/gemini.svg?raw";
import gooseSvg from "../assets/llm/goose.svg?raw";
import grokSvg from "../assets/llm/grok.svg?raw";
import hermesSvg from "../assets/llm/hermes.svg?raw";
import interpreterSvg from "../assets/llm/interpreter.svg?raw";
import ollamaSvg from "../assets/llm/ollama.svg?raw";
import opencodeSvg from "../assets/llm/opencode.svg?raw";
import piSvg from "../assets/llm/pi.svg?raw";

/** Same order as desktop: first hit wins, so specific tokens come first.
 *  Strings match as substrings of the lowercased id/label; `pi` needs a
 *  word boundary so "api" does not hit. */
const RULES: Array<{ match: string | RegExp; id: string; svg: string }> = [
  { match: "claude", id: "claude", svg: claudeSvg },
  { match: "codex", id: "codex", svg: codexSvg },
  { match: "gemini", id: "gemini", svg: geminiSvg },
  { match: "copilot", id: "copilot", svg: copilotSvg },
  { match: "grok", id: "grok", svg: grokSvg },
  { match: "cursor", id: "cursor", svg: cursorSvg },
  { match: "goose", id: "goose", svg: gooseSvg },
  { match: "ollama", id: "ollama", svg: ollamaSvg },
  { match: "opencode", id: "opencode", svg: opencodeSvg },
  { match: "interpreter", id: "interpreter", svg: interpreterSvg },
  { match: "hermes", id: "hermes", svg: hermesSvg },
  { match: "aider", id: "aider", svg: aiderSvg },
  { match: /\bpi\b/, id: "pi", svg: piSvg },
];

function rule(harness: string | null | undefined) {
  const key = (harness || "").toLowerCase().trim();
  if (!key) return null;
  return (
    RULES.find((r) => (typeof r.match === "string" ? key.includes(r.match) : r.match.test(key))) ??
    null
  );
}

/** Icon id for a harness id, binary or label (`Claude Code` → `claude`).
 *  Null when we have no mark: the row shows `>_`. */
export function llmIconId(harness: string | null | undefined): string | null {
  return rule(harness)?.id ?? null;
}

/** Inline SVG markup for a harness, or null. */
export function llmIconSvg(harness: string | null | undefined): string | null {
  return rule(harness)?.svg ?? null;
}
