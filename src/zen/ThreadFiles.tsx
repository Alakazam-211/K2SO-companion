// File chips under a Thread message (K2 0.46.1 `thread-attachments-v1`).
// Each chip is a pointer to a file on the server that owns the Thread, not
// a copy: it shows the state the server computed (ok / changed / gone /
// hidden) and opens through `GET /cli/thread/attachment` on tap
// (AttachmentSheet). One or two files: a chip each. Three or more: one
// compact list card ("3 files") showing up to five rows, the rest behind
// "Show N more".

import { useEffect, useState } from "react";
import { ensureBootStatus, onBootInfo, type DaemonFeature, type ServerScope } from "../api/scope";
import {
  FEATURE_THREAD_ATTACHMENTS,
  LIST_CARD_MAX_ROWS,
  LIST_CARD_MIN_FILES,
  attachmentOpenable,
  formatAttachmentSize,
  isImageAttachment,
  withAttachmentState,
  type ThreadAttachment,
  type ThreadAttachmentState,
} from "../api/threadAttachmentPure";
import { FileIcon } from "./fileIcons/EntryIcon";
import { CHANGED_TEXT, GONE_TEXT, HIDDEN_TEXT } from "./threadFilesText";
import { MessageImages } from "./ThreadImages";
import { MiddleEllipsis } from "./MiddleEllipsis";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { zenScope } from "./zenScope";

export { CHANGED_TEXT, GONE_TEXT, HIDDEN_TEXT };

/** Does `scope`'s server list `feature` (default `thread-attachments-v1`)?
 *  Re-read whenever its `/boot-status` is recorded; asks once (cached) on
 *  mount. */
export function useThreadFilesOn(
  scope: ServerScope,
  feature: DaemonFeature = FEATURE_THREAD_ATTACHMENTS
): boolean {
  const [on, setOn] = useState(() => scope.supports(feature));
  useEffect(() => {
    let live = true;
    const read = () => {
      if (live) setOn(scope.supports(feature));
    };
    read();
    const off = onBootInfo((id) => {
      if (id === scope.id) read();
    });
    if (scope.id) {
      void ensureBootStatus(scope).then(read, () => {});
    }
    return () => {
      live = false;
      off();
    };
  }, [scope, feature]);
  return on;
}

/** A tap's fresh state for one chip, written into the open Thread — only
 *  while the same server's Thread still holds that message. */
export function patchThreadFileState(
  scopeId: string,
  messageId: string,
  n: number,
  state: ThreadAttachmentState
): void {
  if (zenScope().id !== scopeId) return;
  const thread = useZenStore.getState().thread;
  let changed = false;
  const next = thread.map((m): ThreadMessage => {
    if (m.id !== messageId || !m.files) return m;
    const files = withAttachmentState(m.files, n, state);
    if (files === m.files) return m;
    changed = true;
    return { ...m, files };
  });
  if (changed) useZenStore.setState({ thread: next });
}

function chipLabel(a: ThreadAttachment): string {
  if (a.state === "hidden") return HIDDEN_TEXT;
  if (a.state === "gone") return `${a.name}, ${GONE_TEXT}`;
  const size = formatAttachmentSize(a.size);
  const parts = [a.name, size, a.state === "changed" ? CHANGED_TEXT : ""].filter(Boolean);
  return attachmentOpenable(a) ? `Open ${parts.join(", ")}` : parts.join(", ");
}

/** A hidden / unknown chip's glyph: a plain page. */
function PlainFileGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </svg>
  );
}

/** Icon, name, then size / state. One look for a chip and a list row. */
function FileLine({ a, compact }: { a: ThreadAttachment; compact?: boolean }) {
  const hidden = a.state === "hidden";
  const gone = a.state === "gone";
  const iconPx = compact ? 16 : 20;
  const size = formatAttachmentSize(a.size);
  return (
    <>
      <span
        className="flex items-center justify-center shrink-0"
        style={{ width: iconPx + 4, height: iconPx + 4, color: "var(--text-muted)", opacity: gone ? 0.5 : 1 }}
      >
        {hidden || a.kind !== "file" ? <PlainFileGlyph size={iconPx} /> : <FileIcon name={a.name} size={iconPx} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start text-left">
        {hidden ? (
          <span className="max-w-full truncate text-[13px] text-[var(--text-muted)]" data-testid="thread-file-name">
            {HIDDEN_TEXT}
          </span>
        ) : (
          <MiddleEllipsis
            text={a.name}
            className="w-full text-[14px] leading-[18px]"
            style={{
              color: gone ? "var(--text-muted)" : "#fff",
              textDecoration: gone ? "line-through" : undefined,
            }}
            testId="thread-file-name"
          />
        )}
        {hidden ? null : gone ? (
          <span className="text-[11px] leading-[14px] text-[var(--text-muted)]" data-testid="thread-file-sub">
            {GONE_TEXT}
          </span>
        ) : size || a.state === "changed" ? (
          <span className="flex items-center gap-1 text-[11px] leading-[14px] text-[var(--text-muted)]" data-testid="thread-file-sub">
            {size ? <span>{size}</span> : null}
            {a.state === "changed" ? (
              <>
                {size ? <span aria-hidden>·</span> : null}
                <span
                  className="inline-block rounded-full shrink-0"
                  style={{ width: 6, height: 6, background: "var(--warning)" }}
                  data-testid="thread-file-changed-dot"
                  aria-hidden
                />
                <span style={{ color: "var(--warning)" }}>{CHANGED_TEXT}</span>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );
}

const CHIP_STYLE = {
  background: "var(--tile-raised)",
  border: "1px solid rgba(255,255,255,0.10)",
  boxShadow: "var(--tile-sheen)",
  borderRadius: 14,
} as const;

function Chip({ a, onOpen }: { a: ThreadAttachment; onOpen: (a: ThreadAttachment) => void }) {
  const openable = attachmentOpenable(a);
  const common = {
    className: "flex items-center gap-2 min-w-0 px-2.5 py-1.5",
    style: { ...CHIP_STYLE, minWidth: 0, maxWidth: "min(280px, 100%)", opacity: a.state === "hidden" ? 0.8 : 1 },
    "data-testid": "thread-file",
    "data-state": a.state,
    "data-kind": a.kind,
    "aria-label": chipLabel(a),
  } as const;
  if (!openable) {
    return (
      <div {...common} aria-disabled="true">
        <FileLine a={a} />
      </div>
    );
  }
  return (
    <button type="button" {...common} onClick={() => onOpen(a)}>
      <FileLine a={a} />
    </button>
  );
}

function ListCard({ files, onOpen }: { files: readonly ThreadAttachment[]; onOpen: (a: ThreadAttachment) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, LIST_CARD_MAX_ROWS);
  const more = files.length - shown.length;
  return (
    <div className="flex flex-col min-w-0 w-[260px] max-w-full overflow-hidden" style={CHIP_STYLE} data-testid="thread-files-card">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[12px] font-medium text-[var(--text-secondary)]" data-testid="thread-files-count">
        {files.length} files
      </div>
      {shown.map((a) => {
        const openable = attachmentOpenable(a);
        const props = {
          className: "flex items-center gap-2 min-w-0 px-2.5 py-1.5 border-t border-[rgba(255,255,255,0.06)]",
          "data-testid": "thread-file",
          "data-state": a.state,
          "data-kind": a.kind,
          "aria-label": chipLabel(a),
        } as const;
        return openable ? (
          <button key={a.n} type="button" {...props} onClick={() => onOpen(a)}>
            <FileLine a={a} compact />
          </button>
        ) : (
          <div key={a.n} {...props} aria-disabled="true">
            <FileLine a={a} compact />
          </div>
        );
      })}
      {more > 0 ? (
        <button
          type="button"
          className="px-3 py-2 text-left text-[12px] text-[var(--accent)] border-t border-[rgba(255,255,255,0.06)]"
          onClick={() => setAll(true)}
          data-testid="thread-files-more"
        >
          Show {more} more
        </button>
      ) : null}
    </div>
  );
}

/** The files under one message, on the bubble's side. With `imagesOn`
 *  (K2 0.46.3 `thread-images-v1`) pictures draw as thumbnails above the
 *  other files; one the server can't thumbnail goes back to a chip. */
export function MessageFiles({
  files,
  mine,
  hasBubble,
  onOpen,
  imagesOn = false,
  messageId = "",
}: {
  files: readonly ThreadAttachment[];
  mine: boolean;
  /** A bubble sits above: leave a small gap. */
  hasBubble: boolean;
  onOpen: (a: ThreadAttachment) => void;
  imagesOn?: boolean;
  /** The message's doc id (the thumbnail route's `id`). */
  messageId?: string;
}) {
  const [noThumb, setNoThumb] = useState<ReadonlySet<number>>(() => new Set());
  if (!files.length) return null;
  const pictured = (a: ThreadAttachment) =>
    imagesOn && !!messageId && attachmentOpenable(a) && isImageAttachment(a) && !noThumb.has(a.n);
  const images = files.filter(pictured);
  const others = images.length ? files.filter((a) => !pictured(a)) : files;
  const onFallback = (n: number) =>
    setNoThumb((prev) => (prev.has(n) ? prev : new Set(prev).add(n)));
  return (
    <div
      className={`flex flex-col gap-1 min-w-0 max-w-full ${mine ? "items-end" : "items-start"} ${hasBubble ? "mt-1" : ""}`}
      data-testid="thread-files"
      data-side={mine ? "mine" : "theirs"}
    >
      {images.length ? (
        <MessageImages images={images} messageId={messageId} mine={mine} onOpen={onOpen} onFallback={onFallback} />
      ) : null}
      {others.length >= LIST_CARD_MIN_FILES ? (
        <ListCard files={others} onOpen={onOpen} />
      ) : (
        others.map((a) => <Chip key={a.n} a={a} onOpen={onOpen} />)
      )}
    </div>
  );
}
