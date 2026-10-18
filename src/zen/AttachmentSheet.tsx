// A Thread file, opened (K2 0.46.1 `thread-attachments-v1`). Full screen,
// the file viewer's look (name top-left, glass ✕ top-right). Every byte
// comes from `GET /cli/thread/attachment` on the server that owns the
// Thread (the scope captured at tap); the viewers themselves are the file
// viewer's own (FileBody), fed through `FileBytesSourceContext`.
//
//   tap → mode=meta (fresh state; gone → the chip turns gone, a note here)
//       → mode=preview: text (512 KB, jump to `line`), image, PDF
//       → 415 / 413: mode=range in 4 MB chunks — into a viewer when one
//         can paint the type (DOCX, media, ZIP, 3D, big image / PDF), else
//         a file card with the size and Download (Share sheet / save).
//   Above 25 MB a download asks first (no network-type signal here).

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ServerScope } from "../api/scope";
import { downloadAttachment, getAttachmentMeta, getAttachmentPreview } from "../api/threadAttachment";
import {
  LARGE_DOWNLOAD_BYTES,
  attachmentErrorText,
  formatAttachmentSize,
  type AttachmentError,
  type AttachmentRef,
  type ThreadAttachment,
  type ThreadAttachmentState,
} from "../api/threadAttachmentPure";
import { useBackHandler } from "../lib/androidBack";
import { useSwipeBack } from "../lib/useSwipeBack";
import { FileIcon } from "./fileIcons/EntryIcon";
import { BinaryEmptyState, ViewerNote } from "./files/BinaryEmptyState";
import { FileBytesSourceContext, type FileBytesLoader } from "./files/bytesSource";
import { decodeBase64 } from "./files/fileBytes";
import { getFileCategory, isBinaryPreviewCategory } from "./files/fileCategory";
import { shareOrSaveBytes } from "./files/shareFile";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { PaneErrorBoundary } from "./PaneErrorBoundary";
import { CHANGED_TEXT, GONE_TEXT } from "./ThreadFiles";
import "./files/fileViewer.css";

const FileBody = lazy(() => import("./files/FileBody"));

export type OpenAttachment = {
  scope: ServerScope;
  ref: AttachmentRef;
  file: ThreadAttachment;
};

type Then = "view" | "save";

type Phase =
  | { k: "checking" }
  | { k: "gone" }
  | { k: "error"; error: AttachmentError }
  | { k: "confirm"; size: number; then: Then }
  | { k: "loading"; label: string; progress: number | null }
  | { k: "text"; text: string; truncated: boolean; viewId: string }
  | { k: "bytes"; bytes: Uint8Array; viewId: string }
  | { k: "card"; size: number | null; bytes: Uint8Array | null };

/** Categories a viewer paints from bytes (not `binary`). */
function viewerCanPaint(viewId: string): boolean {
  const c = getFileCategory(viewId);
  return isBinaryPreviewCategory(c) && c !== "binary";
}

/** The name the viewer picks its renderer by: the file's own, unless the
 *  server's preview kind says otherwise (an extension-less image…). */
function viewIdFor(file: ThreadAttachment, kind: "text" | "image" | "pdf" | "bytes"): string {
  const base = file.path || file.name || "file";
  const cat = getFileCategory(base);
  if (kind === "text") return isBinaryPreviewCategory(cat) ? `${base}.txt` : base;
  if (kind === "image") return cat === "image" ? base : `${base}.png`;
  if (kind === "pdf") return cat === "pdf" ? base : `${base}.pdf`;
  return base;
}

function folderOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

export function AttachmentSheet({
  open,
  onClose,
  onState,
}: {
  open: OpenAttachment;
  onClose: () => void;
  /** The server's fresh state for this chip (meta / preview). */
  onState: (state: ThreadAttachmentState) => void;
}) {
  const { scope, ref, file } = open;
  const n = file.n;
  const [phase, setPhase] = useState<Phase>({ k: "checking" });
  const [state, setState] = useState<ThreadAttachmentState>(file.state);
  const [sizeNow, setSizeNow] = useState<number | null>(file.size);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const alive = useRef(true);
  /** Bumped per run of the open flow: a stale run (StrictMode's double
   *  effect) stops at its next await. */
  const run = useRef(0);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const swipeRef = useSwipeBack(onClose);
  useBackHandler(true, onClose);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const noteState = useCallback((s: ThreadAttachmentState) => {
    if (!alive.current) return;
    setState(s);
    onStateRef.current(s);
  }, []);

  const failed = useCallback(
    (error: AttachmentError) => {
      if (!alive.current) return;
      if (error.code === "attachment_gone") {
        noteState("gone");
        setPhase({ k: "gone" });
        return;
      }
      setPhase({ k: "error", error });
    },
    [noteState]
  );

  /** Range download, then a viewer (`view`) or the Share sheet (`save`). */
  const download = useCallback(
    async (then: Then) => {
      setPhase({ k: "loading", label: "Downloading…", progress: 0 });
      const r = await downloadAttachment(scope, ref, n, {
        isCancelled: () => !alive.current,
        onProgress: (done, size) => {
          if (alive.current && size > 0) {
            setPhase({ k: "loading", label: "Downloading…", progress: Math.min(1, done / size) });
          }
        },
      });
      if (!alive.current) return;
      if (!r.ok) {
        failed(r.error);
        return;
      }
      const viewId = viewIdFor(file, "bytes");
      if (then === "view" && viewerCanPaint(viewId)) {
        setPhase({ k: "bytes", bytes: r.data.bytes, viewId });
        return;
      }
      setPhase({ k: "card", size: r.data.size, bytes: r.data.bytes });
      if (then === "save") {
        const out = await shareOrSaveBytes(r.data.bytes, file.name, file.mime);
        if (alive.current && out === "failed") setShareNote("Could not save the file.");
      }
    },
    [scope, ref, n, file, failed]
  );

  /** Ask first above 25 MB; otherwise download now. */
  const fetchWhole = useCallback(
    (then: Then, size: number | null) => {
      if (size != null && size > LARGE_DOWNLOAD_BYTES) {
        setPhase({ k: "confirm", size, then });
        return;
      }
      void download(then);
    },
    [download]
  );

  useEffect(() => {
    const mine = ++run.current;
    const live = () => alive.current && run.current === mine;
    void (async () => {
      const meta = await getAttachmentMeta(scope, ref, n);
      if (!live()) return;
      if (!meta.ok) {
        failed(meta.error);
        return;
      }
      setSizeNow(meta.data.size);
      noteState(meta.data.state);
      if (meta.data.state === "gone") {
        setPhase({ k: "gone" });
        return;
      }
      if (meta.data.state === "hidden") {
        setPhase({ k: "error", error: { code: "missing_capability", status: 403, hint: "" } });
        return;
      }
      setPhase({ k: "loading", label: "Loading…", progress: null });
      const p = await getAttachmentPreview(scope, ref, n);
      if (!live()) return;
      if (!p.ok) {
        if (p.error.code === "no_preview" || p.error.code === "preview_too_large") {
          const viewId = viewIdFor(file, "bytes");
          if (viewerCanPaint(viewId)) fetchWhole("view", meta.data.size);
          else setPhase({ k: "card", size: meta.data.size, bytes: null });
          return;
        }
        failed(p.error);
        return;
      }
      if (p.data.state !== meta.data.state) noteState(p.data.state);
      if (p.data.kind === "text") {
        setPhase({ k: "text", text: p.data.text, truncated: p.data.truncated, viewId: viewIdFor(file, "text") });
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(p.data.base64);
      } catch {
        setPhase({ k: "error", error: { code: "bad_response", status: null, hint: "preview: bad base64" } });
        return;
      }
      setPhase({ k: "bytes", bytes, viewId: viewIdFor(file, p.data.kind) });
    })();
    // Once per open sheet (the parent keys it by message + n).
  }, []);

  const bytes = phase.k === "bytes" ? phase.bytes : phase.k === "card" ? phase.bytes : null;
  const loader = useMemo<FileBytesLoader | null>(
    () => (phase.k === "bytes" ? async () => phase.bytes : null),
    [phase]
  );

  async function onShare() {
    if (!bytes) return;
    setShareNote(null);
    const out = await shareOrSaveBytes(bytes, file.name, file.mime);
    if (alive.current && out === "failed") setShareNote("Could not save the file.");
  }

  const folder = folderOf(file.path);
  const body = (() => {
    switch (phase.k) {
      case "checking":
        return <ViewerNote title="Checking the file…" testId="attachment-checking" />;
      case "gone":
        return (
          <ViewerNote
            tone="error"
            title={GONE_TEXT}
            detail="The file was moved, deleted, or is no longer shareable."
            testId="attachment-gone"
          />
        );
      case "error":
        return (
          <ViewerNote
            tone="error"
            title={attachmentErrorText(phase.error)}
            detail={phase.error.code === "http" || phase.error.code === "network" || phase.error.code === "bad_response" ? phase.error.hint : null}
            testId="attachment-error"
          />
        );
      case "confirm":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center" data-testid="attachment-confirm">
            <span className="text-[15px] text-[var(--text)]">This file is {formatAttachmentSize(phase.size)}.</span>
            <span className="text-[12px] text-[var(--text-muted)]">Downloading it may use a lot of cellular data.</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="zen-glass zen-glass-pill px-4 text-[14px]"
                style={{ height: 36, color: "#fff" }}
                onClick={() => setPhase({ k: "card", size: phase.size, bytes: null })}
                data-testid="attachment-confirm-cancel"
              >
                Not now
              </button>
              <button
                type="button"
                className="rounded-full px-4 text-[14px] font-medium"
                style={{ height: 36, background: "#0a84ff", color: "#fff" }}
                onClick={() => void download(phase.then)}
                data-testid="attachment-confirm-download"
              >
                Download
              </button>
            </div>
          </div>
        );
      case "loading":
        return (
          <ViewerNote
            title={`${phase.label}${phase.progress != null ? ` ${Math.round(phase.progress * 100)}%` : ""}`}
            testId="attachment-loading"
          />
        );
      case "text":
        return (
          <div className="flex h-full flex-col">
            {phase.truncated ? (
              <div className="shrink-0 mx-4 mb-2 text-[12px] text-[var(--text-muted)]" data-testid="attachment-truncated">
                Showing the first 512 KB of this file.
              </div>
            ) : null}
            <div className="relative flex-1 min-h-0">
              <FileBody
                file={{ id: phase.viewId, name: file.name, body: phase.text, loaded: true }}
                source={file.line != null}
                stub={false}
                line={file.line}
                lineEnd={file.lineEnd}
              />
            </div>
          </div>
        );
      case "bytes":
        return (
          <FileBytesSourceContext.Provider value={loader}>
            <FileBody
              file={{ id: phase.viewId, name: file.name, body: "", loaded: true, fsPath: phase.viewId }}
              source={false}
              stub={false}
            />
          </FileBytesSourceContext.Provider>
        );
      case "card":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8" data-testid="attachment-card">
            <div className="h-auto">
              <BinaryEmptyState
                filePath={file.name}
                message="No preview for this file."
                detail={[file.name, formatAttachmentSize(phase.size ?? sizeNow)].filter(Boolean).join(" · ")}
              />
            </div>
            <button
              type="button"
              className="rounded-full px-5 text-[14px] font-medium"
              style={{ height: 38, background: "#0a84ff", color: "#fff" }}
              onClick={() => (phase.bytes ? void onShare() : fetchWhole("save", phase.size ?? sizeNow))}
              data-testid="attachment-download"
            >
              {phase.bytes ? "Share / Save" : "Download"}
            </button>
            {shareNote ? <span className="text-[12px] text-[var(--warning)]">{shareNote}</span> : null}
          </div>
        );
    }
  })();

  const sheet = (
    <div
      ref={swipeRef}
      className="fixed inset-0 flex flex-col bg-[var(--background)] fv-root"
      style={{ zIndex: 60 }}
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      data-testid="attachment-sheet"
      data-scope={scope.id}
    >
      <header
        className="relative flex items-center gap-2 shrink-0 px-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 8px)", paddingBottom: 10 }}
      >
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <span className="flex w-full min-w-0 items-center gap-1 text-[16px] font-semibold text-[var(--text)]">
            <span className="shrink-0 flex">
              <FileIcon name={file.name} size={18} />
            </span>
            <MiddleEllipsis text={file.name} testId="attachment-name" className="flex-1" />
          </span>
          <span className="flex max-w-full items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
            {folder ? <span className="truncate">{folder}</span> : null}
            {state === "changed" ? (
              <span className="flex shrink-0 items-center gap-1" style={{ color: "var(--warning)" }} data-testid="attachment-changed">
                <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: "var(--warning)" }} aria-hidden />
                {CHANGED_TEXT}
              </span>
            ) : null}
          </span>
        </div>
        {bytes && phase.k === "bytes" ? (
          <button
            type="button"
            className="shrink-0 px-3 text-[13px] zen-glass zen-glass-pill"
            style={{ height: 34, color: "#fff" }}
            onClick={() => void onShare()}
            data-testid="attachment-share"
          >
            Share
          </button>
        ) : null}
        <button
          type="button"
          className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
          style={{ width: 34, height: 34, color: "#fff" }}
          onClick={onClose}
          aria-label="Close"
          data-testid="attachment-close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <div className="relative flex-1 min-h-0">
        <PaneErrorBoundary key={phase.k} name="file">
          <Suspense fallback={<ViewerNote title="Loading…" />}>{body}</Suspense>
        </PaneErrorBoundary>
      </div>
    </div>
  );
  if (typeof document === "undefined") return null;
  return createPortal(sheet, document.body);
}
