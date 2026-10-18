import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { highlightToHtml } from "./highlight";

/** Mark lines `line..lineEnd` (1-based) under `root` and bring the first
 *  into view. Shiki and the plain fallback both emit one `.line` per line. */
function markLines(root: HTMLElement, line: number, lineEnd: number | null | undefined): void {
  const rows = root.querySelectorAll<HTMLElement>(".line");
  if (!rows.length) return;
  const first = Math.min(Math.max(1, line), rows.length);
  const last = Math.min(Math.max(first, lineEnd ?? first), rows.length);
  for (let i = first; i <= last; i++) {
    rows[i - 1].classList.add("fv-line-hl");
    rows[i - 1].setAttribute("data-hl", "true");
  }
  const el = rows[first - 1];
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
}

/** Shiki-highlighted source. Plain text paints first; the highlight
 *  swaps in when shiki (lazy) is ready. `wrap` suits prose-like text;
 *  code keeps its indentation and scrolls sideways. `line` (1-based, with
 *  an optional `lineEnd`) is highlighted and scrolled into view. */
export function CodeView({
  code,
  lang,
  wrap = false,
  line = null,
  lineEnd = null,
}: {
  code: string;
  lang: string | null;
  wrap?: boolean;
  line?: number | null;
  lineEnd?: number | null;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void highlightToHtml(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  useLayoutEffect(() => {
    if (line != null && rootRef.current) markLines(rootRef.current, line, lineEnd);
  }, [html, code, line, lineEnd]);

  const cls = `fv-code ${wrap ? "fv-code-wrap" : ""}`;
  if (html) {
    return <div ref={rootRef} className={cls} data-testid="file-code" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (line != null) {
    // One span per line, like shiki's, so the jump works before it loads.
    const lines = code.split("\n");
    return (
      <div ref={rootRef} className={cls} data-testid="file-code">
        <pre>
          <code>
            {lines.map((l, i) => (
              <span key={i} className="line">
                {l}
                {i < lines.length - 1 ? "\n" : null}
              </span>
            ))}
          </code>
        </pre>
      </div>
    );
  }
  return (
    <div ref={rootRef} className={cls} data-testid="file-code">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Markdown fence: same highlighter, boxed like a chat code block. */
export function FenceBlock({ code, lang }: { code: string; lang: string | null }) {
  return (
    <div className="fv-fence">
      <CodeView code={code} lang={lang} />
    </div>
  );
}
