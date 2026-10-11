import { useEffect, useState } from "react";
import { highlightToHtml } from "./highlight";

/** Shiki-highlighted source. Plain text paints first; the highlight
 *  swaps in when shiki (lazy) is ready. `wrap` suits prose-like text;
 *  code keeps its indentation and scrolls sideways. */
export function CodeView({
  code,
  lang,
  wrap = false,
}: {
  code: string;
  lang: string | null;
  wrap?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

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

  const cls = `fv-code ${wrap ? "fv-code-wrap" : ""}`;
  if (html) {
    return <div className={cls} data-testid="file-code" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <div className={cls} data-testid="file-code">
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
