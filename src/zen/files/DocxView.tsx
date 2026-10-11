import { useEffect, useState } from "react";
import { ViewerNote } from "./BinaryEmptyState";
import { sanitizeHtml } from "./sanitizeHtml";
import { useFileBytes } from "./useFileBytes";

type Mammoth = {
  convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
};

/** Mammoth (lazy) → HTML → allowlist sanitizer, painted in the page so it
 *  scrolls like any other document (desktop `DocxViewer`). `.doc` is not
 *  OOXML: mammoth refuses it and the error says so. */
export function DocxView({ path }: { path: string | null }) {
  const { bytes, error: loadError } = useFileBytes(path);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    if (!bytes) return;
    void (async () => {
      try {
        const mod = (await import("mammoth")) as unknown as Mammoth & { default?: Mammoth };
        const mammoth = mod.default ?? mod;
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const r = await mammoth.convertToHtml({ arrayBuffer: copy.buffer });
        if (!cancelled) setHtml(sanitizeHtml(r.value));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const err = loadError || error;
  if (err) return <ViewerNote tone="error" title="Could not open the document" detail={err} />;
  if (html === null) return <ViewerNote title="Converting document…" />;
  if (!html.trim()) return <ViewerNote title="The document is empty" />;
  return (
    <div
      className="markdown-content fv-docx"
      data-testid="file-docx"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
