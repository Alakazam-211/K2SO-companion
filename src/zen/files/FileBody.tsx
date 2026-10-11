// Viewer dispatch (desktop `FileViewerPane` content switch). Lazy-loaded
// by FileViewer, so none of this is in the start-up chunk; the heavy
// libraries (shiki, pdf.js, mammoth, mermaid, dxf-parser, three.js) are
// dynamic imports again inside their viewers and load only for the file
// type that needs them.

import type { ReactNode } from "react";
import type { StubFile } from "../stubData";
import { BinaryEmptyState, ViewerNote } from "./BinaryEmptyState";
import { CodeView } from "./CodeView";
import { CsvView } from "./CsvView";
import { DiagramView } from "./DiagramView";
import { DocxView } from "./DocxView";
import { DxfView } from "./DxfView";
import { getFileCategory, isBinaryPreviewCategory } from "./fileCategory";
import { detectLanguage } from "./highlight";
import { HtmlView } from "./HtmlView";
import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { MediaView } from "./MediaView";
import { PdfView } from "./PdfView";
import { ZipView } from "./ZipView";

/** Text past this is cut, with a note (the daemon itself stops at 10MB). */
export const TEXT_VIEW_MAX_CHARS = 1_000_000;

/** A document that scrolls inside the viewer, clear of the home bar. */
function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full overflow-auto fv-scroll fv-safe-bottom" data-testid="file-scroll">
      {children}
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export default function FileBody({
  file,
  source,
  stub,
  onFileLink,
}: {
  file: StubFile;
  /** Show the raw text instead of the rendered view. */
  source: boolean;
  stub: boolean;
  onFileLink?: (ref: string) => void;
}) {
  const path = file.fsPath ?? null;
  const category = getFileCategory(file.id);

  if (isBinaryPreviewCategory(category)) {
    if (stub || category === "binary") return <BinaryEmptyState filePath={file.id} />;
    if (!file.loaded) return <ViewerNote title="Loading…" />;
    if (category === "image") return <ImageView path={path} name={file.name} />;
    if (category === "pdf") return <PdfView path={path} />;
    if (category === "audio" || category === "video") return <MediaView path={path} kind={category} />;
    if (category === "docx") return <Scroll><DocxView path={path} /></Scroll>;
    return <Scroll><ZipView path={path} /></Scroll>;
  }

  if (file.readError) {
    if (category === "cad2d" && /binary/i.test(file.readError)) {
      return (
        <BinaryEmptyState
          filePath={file.id}
          message="Binary DXF is not supported."
          detail="Save it as ASCII DXF to preview it here."
        />
      );
    }
    if (/binary/i.test(file.readError)) {
      return <BinaryEmptyState filePath={file.id} detail={file.name} />;
    }
    return <ViewerNote tone="error" title="Could not open the file" detail={file.readError} testId="file-error" />;
  }
  if (!file.loaded && !file.body) return <ViewerNote title="Loading…" />;

  const full = file.body;
  const cut = full.length > TEXT_VIEW_MAX_CHARS;
  const text = cut ? full.slice(0, TEXT_VIEW_MAX_CHARS) : full;
  const note = cut ? (
    <div className="mx-4 mb-2 text-[12px] text-[var(--text-muted)]" data-testid="file-truncated">
      Showing the first {Math.round(TEXT_VIEW_MAX_CHARS / 1000).toLocaleString()} KB of{" "}
      {Math.round(full.length / 1000).toLocaleString()} KB.
    </div>
  ) : null;
  const lang = detectLanguage(file.id);

  if (source || category === "text") {
    // Prose-like text wraps; code keeps its lines and scrolls sideways.
    const wrap = !lang || lang === "markdown" || lang === "log";
    return <Scroll>{note}<CodeView code={text} lang={lang} wrap={wrap} /></Scroll>;
  }
  if (category === "json") return <Scroll>{note}<CodeView code={cut ? text : prettyJson(text)} lang="json" /></Scroll>;
  if (category === "markdown") return <Scroll>{note}<MarkdownView content={text} onFileLink={onFileLink} /></Scroll>;
  if (category === "csv") return <CsvView content={text} filePath={file.id} />;
  if (category === "html") return <HtmlView html={text} title={file.name} />;
  // The whole body, uncut: a DXF is drawn, never shown as text.
  if (category === "cad2d") return <DxfView text={full} />;
  if (category === "mermaid") return <Scroll><DiagramView content={text} filePath={file.id} mode="mermaid" /></Scroll>;
  return <Scroll>{note}<DiagramView content={text} filePath={file.id} mode="source" /></Scroll>;
}
