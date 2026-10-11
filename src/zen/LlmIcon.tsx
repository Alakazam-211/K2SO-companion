import { llmIconId, llmIconSvg } from "./llmIcons";

export const LLM_ICON_PX = 20;

/** The `>_` console glyph: plain shells and harnesses we have no mark for. */
export function ConsoleGlyph({ size = LLM_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-[var(--text-muted)]"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

/** Leading icon of a session row: a custom preset's emoji when given,
 *  else the LLM's mark, else `>_`. The vendored marks size by `1em`, so
 *  `fontSize` sets the icon size (desktop AgentIcon). */
export function LlmIcon({
  harness,
  emoji,
  size = LLM_ICON_PX,
}: {
  harness: string | null | undefined;
  emoji?: string | null;
  size?: number;
}) {
  const svg = llmIconSvg(harness);
  const id = llmIconId(harness);
  const box = {
    width: size,
    height: size,
    fontSize: size,
    lineHeight: 1,
    color: "var(--text)",
  } as const;
  if (emoji) {
    return (
      <span
        className="inline-flex items-center justify-center shrink-0"
        style={{ ...box, fontSize: Math.round(size * 0.85) }}
        data-testid="llm-icon"
        data-llm="emoji"
        aria-hidden
      >
        {emoji}
      </span>
    );
  }
  if (!svg) {
    return (
      <span className="inline-flex items-center justify-center shrink-0" style={box} data-testid="llm-icon" data-llm="shell">
        <ConsoleGlyph size={size} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={box}
      data-testid="llm-icon"
      data-llm={id ?? undefined}
      aria-hidden
      // Vendored, bundled SVG files only; never server text.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
