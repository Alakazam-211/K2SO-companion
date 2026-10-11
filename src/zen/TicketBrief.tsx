import { useMemo, type ReactNode } from "react";
import type { FeedbackBrief } from "../api/feedbackPure";
import {
  briefRenderable,
  buildBriefSrcDoc,
  type BriefLink,
  type BriefSrcDoc,
} from "../api/ticketBrief";
import { openExternal } from "../lib/openExternal";
import type { BriefEntry } from "../stores/feedback";
import { zenTextPx } from "./zenFont";

// The open ticket's brief, Zen style (Layout A). A `.k2-tile` card with a
// fixed-height preview of the brief in an inert frame (`sandbox=""`, CSP
// meta first — see api/ticketBrief.ts), a fade, and "Read full brief",
// which opens BriefReader. The preview frame takes no touches
// (pointer-events:none) so a swipe over it scrolls the conversation, not
// a trapped inner scroller; tapping the card opens the reader.
//
// Fallbacks: a brief whose sanitizer isn't `k2-brief-v1`, a null brief or
// a failed load shows `brief.text` (pre-wrap) or the `body`. A ticket with
// no brief shows its `body` as "Summary"; with no body either, no card.

const CARD_RADIUS = 16;

/** Memo on sha256: event refetches never rebuild (or reload) the frame. */
export function useBriefDoc(brief: FeedbackBrief | null): BriefSrcDoc | null {
  const sha = brief?.sha256 ?? "";
  const ok = briefRenderable(brief);
  return useMemo(
    () => (ok && brief ? buildBriefSrcDoc(brief.html) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sha, ok]
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function CardLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div
      className="flex items-baseline gap-2 text-[11px] uppercase tracking-wider"
      style={{ color: "#8e8e93", padding: "12px 14px 6px" }}
    >
      <span className="font-semibold">{children}</span>
      {right ? <span className="ml-auto normal-case tracking-normal tabular-nums">{right}</span> : null}
    </div>
  );
}

/** The inert frame. `fill` = the reader (own scroll); else the preview. */
export function BriefFrame({
  doc,
  title,
  fill,
  testId,
}: {
  doc: BriefSrcDoc;
  title: string;
  fill?: boolean;
  testId: string;
}) {
  return (
    <iframe
      title={`Brief: ${title}`}
      data-testid={testId}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc.frameHtml}
      className="block w-full border-0"
      style={
        fill
          ? { height: "100%", background: "#1c1c1e" }
          : {
              position: "absolute",
              inset: 0,
              height: "100%",
              background: "#1c1c1e",
              pointerEvents: "none",
            }
      }
    />
  );
}

/** "Links in this brief" — full URLs, opened in the system browser. */
export function BriefLinks({ links, maxHeight }: { links: BriefLink[]; maxHeight?: number }) {
  if (links.length === 0) return null;
  return (
    <div data-testid="brief-links" style={{ padding: "8px 4px 0" }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#8e8e93" }}>
        Links in this brief
      </div>
      <ol
        className="flex flex-col gap-1 mt-1 overflow-y-auto"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {links.map((l) => (
          <li key={l.n} className="flex items-baseline gap-1.5 min-w-0 text-[14px]">
            <span className="tabular-nums shrink-0" style={{ color: "#8e8e93" }}>
              [{l.n}]
            </span>
            <button
              type="button"
              data-testid="brief-link"
              onClick={() => void openExternal(l.url)}
              className="min-w-0 truncate text-left bg-transparent border-0 p-0"
              style={{ color: "var(--accent)" }}
            >
              {l.url}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Plain-text card: the summary (no brief) or the brief's text fallback. */
function TextCard({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <section className="k2-tile overflow-hidden" style={{ borderRadius: CARD_RADIUS }} data-testid={testId}>
      <CardLabel>{label}</CardLabel>
      <div
        className="leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        style={{ padding: "0 14px 14px", color: "var(--text)", fontSize: zenTextPx(15) }}
      >
        {text}
      </div>
    </section>
  );
}

export function BriefCard({
  hasBrief,
  entry,
  body,
  title,
  onRead,
}: {
  hasBrief: boolean;
  entry: BriefEntry | undefined;
  body: string | null;
  title: string;
  onRead: () => void;
}) {
  const brief = entry?.state === "ready" ? entry.brief : null;
  const doc = useBriefDoc(brief);
  const summary = (body ?? "").trim();

  if (!hasBrief) {
    return summary ? <TextCard label="Summary" text={summary} testId="ticket-summary" /> : null;
  }
  if (!entry || entry.state === "loading") {
    return (
      <section className="k2-tile overflow-hidden" style={{ borderRadius: CARD_RADIUS }} data-testid="brief-loading">
        <CardLabel>Brief</CardLabel>
        <p className="text-[14px]" style={{ padding: "0 14px 14px", color: "#8e8e93" }}>
          Loading brief…
        </p>
      </section>
    );
  }
  if (!doc) {
    // Unknown sanitizer, null brief or a failed load: never render HTML.
    const text = (brief?.text ?? "").trim() || summary;
    return text ? <TextCard label="Brief" text={text} testId="brief-fallback" /> : null;
  }
  return (
    <div>
      <section
        className="k2-tile overflow-hidden"
        style={{ borderRadius: CARD_RADIUS }}
        data-testid="brief-card"
      >
        <CardLabel right={brief ? `HTML · ${formatBytes(brief.bytes)}` : null}>Brief</CardLabel>
        {/* A div, not a button: a frame isn't allowed inside a button. */}
        <div
          role="button"
          tabIndex={0}
          onClick={onRead}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onRead();
          }}
          aria-label="Read full brief"
          data-testid="brief-preview"
          className="relative block w-full"
          style={{ height: "40vh", minHeight: 180 }}
        >
          <BriefFrame doc={doc} title={title} testId="brief-preview-frame" />
          <span
            aria-hidden
            className="absolute left-0 right-0 bottom-0 pointer-events-none"
            style={{
              height: 72,
              background: "linear-gradient(to bottom, rgba(28,28,30,0), #1c1c1e)",
            }}
          />
        </div>
        <button
          type="button"
          data-testid="brief-read-full"
          onClick={onRead}
          className="w-full text-[15px] font-medium bg-transparent border-0"
          style={{
            padding: "12px 14px",
            color: "var(--accent)",
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          Read full brief
        </button>
      </section>
      <BriefLinks links={doc.links} />
    </div>
  );
}

/** Full-screen reader: the frame fills the height and scrolls itself (an
 *  iOS 13+ WKWebView scrolls sub-frames on its own — the native scroll
 *  disable in lib.rs only touches the top-level scroll view). Links sit
 *  under it, the answer pills are pinned at the bottom. */
export function BriefReader({
  doc,
  title,
  onClose,
  footer,
}: {
  doc: BriefSrcDoc;
  title: string;
  onClose: () => void;
  footer?: ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 12, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="brief-reader"
      role="dialog"
      aria-label={`Brief: ${title}`}
    >
      <div className="flex items-center gap-3 shrink-0" style={{ padding: "12px 12px 8px", minHeight: 44 }}>
        <button
          type="button"
          data-testid="brief-reader-close"
          className="text-[17px] zen-glass zen-glass-pill shrink-0"
          style={{ minHeight: 34, padding: "0 14px", color: "#fff" }}
          onClick={onClose}
        >
          Close
        </button>
        <span className="flex-1 min-w-0 truncate text-[15px] font-semibold">{title}</span>
      </div>
      <div className="flex-1 min-h-0 mx-3 k2-tile overflow-hidden" style={{ borderRadius: CARD_RADIUS }}>
        <BriefFrame doc={doc} title={title} fill testId="brief-reader-frame" />
      </div>
      <div className="shrink-0 px-3">
        <BriefLinks links={doc.links} maxHeight={96} />
      </div>
      {footer ? (
        <div
          className="shrink-0 px-3 pt-2"
          style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}
          data-testid="brief-reader-footer"
        >
          {footer}
        </div>
      ) : (
        <div className="shrink-0" style={{ height: "max(10px, env(safe-area-inset-bottom))" }} />
      )}
    </div>
  );
}
