import { useEffect, useId, useRef, useState } from "react";
import { CodeView } from "./CodeView";
import { getFileExtension } from "./fileCategory";
import { detectLanguage } from "./highlight";
import { ViewerNote } from "./BinaryEmptyState";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

/** Desktop `DiagramViewer`: Mermaid renders (lazy import, strict
 *  security); draw.io / PlantUML / Graphviz have no client renderer, so
 *  they show a note and the source. */
export function DiagramView({
  content,
  filePath,
  mode,
}: {
  content: string;
  filePath: string;
  mode: "mermaid" | "source";
}) {
  if (mode === "mermaid") return <MermaidView content={content} />;
  const ext = getFileExtension(filePath);
  const label =
    ext === ".drawio" || ext === ".dio"
      ? "Draw.io diagram"
      : ext === ".puml" || ext === ".plantuml"
        ? "PlantUML source"
        : "Graphviz DOT source";
  return (
    <div data-testid="file-diagram-source">
      <div className="mx-4 mb-2 k2-tile rounded-[14px] px-3 py-2.5">
        <div className="text-[13px] text-[var(--text)]">{label}</div>
        <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-muted)]">
          No renderer for this diagram type on the phone. The source is below.
        </div>
      </div>
      <CodeView code={content} lang={detectLanguage(filePath)} />
    </div>
  );
}

function MermaidView({ content }: { content: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [state, setState] = useState<"loading" | "ok" | "empty">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (host) host.innerHTML = "";
    setError(null);
    const source = content.trim();
    if (!source) {
      setState("empty");
      return;
    }
    setState("loading");
    const id = `mmd-${reactId}-${Math.random().toString(36).slice(2, 8)}`;
    void (async () => {
      try {
        const mod = (await import("mermaid")) as unknown as { default: MermaidApi };
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          // Diagram text never runs as HTML.
          securityLevel: "strict",
          theme: "dark",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        });
        const { svg } = await mermaid.render(id, source);
        if (cancelled) return;
        if (hostRef.current) hostRef.current.innerHTML = svg;
        setState("ok");
      } catch (e) {
        // A failed render leaves its scratch node on <body>.
        document.getElementById(`d${id}`)?.remove();
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("ok");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, reactId]);

  return (
    <div data-testid="file-mermaid">
      {state === "loading" ? <ViewerNote title="Rendering diagram…" /> : null}
      {state === "empty" ? <ViewerNote title="Empty Mermaid file" /> : null}
      {error ? (
        <div className="mx-4 k2-tile rounded-[14px] px-3 py-2.5">
          <div className="text-[13px] text-[var(--warning)]">Mermaid could not render this</div>
          <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)] whitespace-pre-wrap break-words">
            {error}
          </div>
        </div>
      ) : null}
      <div ref={hostRef} className="fv-mermaid px-4" />
    </div>
  );
}
