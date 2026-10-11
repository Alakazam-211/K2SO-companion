import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ViewerNote } from "./BinaryEmptyState";
import { useFileBytes } from "./useFileBytes";

/** iOS caps one canvas near 16.7M pixels and all canvases near a few
 *  hundred MB: cap each page and free the ones far off screen. */
const MAX_CANVAS_PIXELS = 12_000_000;
const MAX_DPR = 2.5;

/** pdf.js, legacy build: the modern build needs Safari 17-era built-ins
 *  (Promise.withResolvers, etc). iOS 15 WKWebView gets the polyfilled one.
 *  The worker is an asset URL; pdf.js falls back to a main-thread
 *  "fake worker" if WKWebView refuses to start it. */
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** Every page, stacked, each rendered when it nears the screen
 *  (desktop `PDFViewer` paints one page with pager buttons; a phone
 *  scrolls). Canvases are sized to the width × device pixel ratio. */
export function PdfView({ path }: { path: string | null }) {
  const { bytes, error: loadError } = useFileBytes(path);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [aspect, setAspect] = useState(1.294);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    if (!bytes) return;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // pdf.js transfers the buffer to its worker: hand it a copy.
        const data = new Uint8Array(bytes.byteLength);
        data.set(bytes);
        opened = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        const first = await opened.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) {
          void opened.destroy();
          return;
        }
        setAspect(vp.height / vp.width);
        setDoc(opened);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void opened.destroy();
    };
  }, [bytes]);

  // Width follows rotation; pages re-render at the new size.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - 24));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const err = loadError || error;
  if (err) return <ViewerNote tone="error" title="Could not open the PDF" detail={err} />;
  if (!doc) return <ViewerNote title="Loading PDF…" />;

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto overflow-x-hidden fv-scroll fv-safe-bottom"
      data-testid="file-pdf"
    >
      <div className="flex flex-col items-center gap-3 px-3 pt-1">
        {width > 0
          ? Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage key={i} doc={doc} n={i + 1} width={width} aspect={aspect} root={scrollRef} />
            ))
          : null}
        <div className="pb-2 text-[11px] text-[var(--text-muted)]">
          {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  n,
  width,
  aspect: guess,
  root,
}: {
  doc: PDFDocumentProxy;
  n: number;
  width: number;
  aspect: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    // Render within ~1.5 screens; free beyond that.
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { root: root.current, rootMargin: "1200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      // Off screen: give the bitmap back to iOS.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        let scale = (width / base.width) * dpr;
        const pixels = base.width * scale * base.height * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const vp = page.getViewport({ scale });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        task = page.render({ canvas, viewport: vp });
        await task.promise;
      } catch {
        // RenderingCancelledException on scroll-away; a page error leaves
        // its blank card.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, n, width]);

  const a = aspect ?? guess;
  return (
    <div
      ref={boxRef}
      className="relative bg-white rounded-[4px] overflow-hidden"
      style={{ width, height: Math.round(width * a) }}
      data-testid="pdf-page"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
