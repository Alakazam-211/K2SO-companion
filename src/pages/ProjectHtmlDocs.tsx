// Slice C2 — the HTML dashboards browser (PRD §2): the project's pinned
// HTML docs (`/cli/project-group/html-docs`, grouped by workspace),
// tapped open in a SANDBOXED iframe (`srcDoc`, `sandbox="allow-scripts"`
// — no same-origin, no navigation, no popups) fed by
// `/cli/fs/read-file`.
//
// MOBILE SCROLL (docs/ios-keyboard-layout.md): the app disables the
// WKWebView's native scroll layer, and touches over an opaque-origin
// iframe never reach the parent — so the doc CANNOT rely on iframe-
// internal scrolling. Instead a tiny helper script is appended to the
// fetched HTML: it (a) postMessages the document's content height so
// the iframe is sized to its content inside a scrollable container
// (overflow auto + -webkit-overflow-scrolling: touch), and (b) forwards
// touch/wheel deltas so gestures STARTING over the iframe scroll that
// container too. The sandbox stays intact — postMessage is the only
// channel, and the parent validates a nonce so a hostile doc can't
// spoof someone else's frame.
//
// Full-screen overlay (same rationale as ProjectChat: the /chat/:id
// chrome-hiding behavior without editing the shared nav components).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchFileContent,
  fetchProjectGroupHtmlDocs,
  type ProjectGroupHtmlDoc,
} from "../api/projectGroups";
import { useServersStore } from "../stores/servers";
import { groupHtmlDocsByWorkspace } from "../lib/projectChat";

/** The helper appended to every fetched doc body. Interpolates the
 *  per-mount nonce so the parent can attribute messages. */
function docBridgeScript(nonce: string): string {
  return (
    "<script>(function(){" +
    `var N=${JSON.stringify(nonce)};` +
    'function send(k,v){try{parent.postMessage({k2doc:N,kind:k,value:v},"*")}catch(e){}}' +
    "function h(){send('height',Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))}" +
    "window.addEventListener('load',h);setTimeout(h,60);setTimeout(h,600);" +
    "try{new ResizeObserver(h).observe(document.documentElement)}catch(e){}" +
    "var y=null;" +
    "document.addEventListener('touchstart',function(e){y=e.touches[0].clientY},{passive:true});" +
    "document.addEventListener('touchmove',function(e){if(y==null)return;var n=e.touches[0].clientY;send('scroll',y-n);y=n},{passive:true});" +
    "document.addEventListener('touchend',function(){y=null},{passive:true});" +
    "document.addEventListener('wheel',function(e){send('scroll',e.deltaY)},{passive:true});" +
    "})()</script>"
  );
}

export function ProjectHtmlDocs() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const activeServerId = useServersStore((s) => s.activeServerId);

  const [docs, setDocs] = useState<ProjectGroupHtmlDoc[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The open doc + its fetched body.
  const [openDoc, setOpenDoc] = useState<ProjectGroupHtmlDoc | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  // Content-height reported by the sandboxed doc (via postMessage).
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nonce = useMemo(
    () => globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}`,
    []
  );

  const loadDocs = useCallback(async (): Promise<void> => {
    if (!groupId) return;
    const r = await fetchProjectGroupHtmlDocs(groupId);
    if (r.ok) {
      setDocs(r.data ?? []);
      setDocsError(null);
    } else {
      setDocsError(r.error ?? "Failed to load dashboards");
    }
  }, [groupId]);

  useEffect(() => {
    setDocs(null);
    void loadDocs();
  }, [loadDocs, activeServerId]);

  const loadBody = useCallback(async (doc: ProjectGroupHtmlDoc): Promise<void> => {
    setBodyLoading(true);
    setBodyError(null);
    const r = await fetchFileContent(doc.filePath);
    setBodyLoading(false);
    if (r.ok && r.data) {
      setFrameHeight(null); // re-measure the fresh document
      setBody(r.data.content);
    } else {
      setBody(null);
      setBodyError(r.error ?? "Failed to read file");
    }
  }, []);

  const openDocument = (doc: ProjectGroupHtmlDoc) => {
    setOpenDoc(doc);
    setBody(null);
    setFrameHeight(null);
    void loadBody(doc);
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    if (openDoc) await loadBody(openDoc);
    else await loadDocs();
    setRefreshing(false);
  };

  // The doc's postMessage bridge: size the iframe to its content, and
  // scroll OUR container for gestures that started over the iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { k2doc?: string; kind?: string; value?: number } | null;
      if (!d || d.k2doc !== nonce || typeof d.value !== "number") return;
      if (d.kind === "height" && d.value > 0) {
        setFrameHeight(Math.ceil(d.value));
      } else if (d.kind === "scroll") {
        const el = scrollRef.current;
        if (el) el.scrollTop += d.value;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce]);

  if (!groupId) return null;

  const sections = docs ? groupHtmlDocsByWorkspace(docs) : [];

  return (
    <div className="fixed inset-0 z-40 bg-[var(--background)]">
      <div
        className="flex flex-col h-full"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Header: back · title · refresh */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
          <button
            onClick={() => {
              if (openDoc) {
                setOpenDoc(null);
                setBody(null);
                setBodyError(null);
              } else {
                navigate(`/projects/${groupId}`);
              }
            }}
            aria-label="Back"
            className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 -ml-2"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 1L3 7l6 6" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-[var(--text)] text-[13px] font-semibold truncate">
              {openDoc ? openDoc.fileName : "Dashboards"}
            </div>
            {openDoc?.agentName && (
              <div className="text-[var(--text-muted)] text-[10px] truncate">
                {openDoc.agentName}
              </div>
            )}
          </div>
          <button
            onClick={handleRefresh}
            aria-label="Refresh"
            className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0"
            style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        </div>

        {openDoc ? (
          /* ── Viewer: the container scrolls, never the webview ── */
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-auto"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {bodyError ? (
              <div className="flex flex-col items-center justify-center h-full px-8 gap-3">
                <span className="text-[var(--error)] text-[12px] text-center">{bodyError}</span>
                <button
                  onClick={() => void loadBody(openDoc)}
                  className="px-4 py-2 border border-[var(--accent-dim)] text-[var(--accent)] text-[12px]"
                >
                  Retry
                </button>
              </div>
            ) : bodyLoading || body === null ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-[var(--text-muted)] text-[12px]">Loading document…</span>
              </div>
            ) : (
              <iframe
                title={openDoc.fileName}
                sandbox="allow-scripts"
                srcDoc={body + docBridgeScript(nonce)}
                className="block w-full border-0 bg-white"
                // Sized to the doc's reported content height so the
                // OUTER container owns scrolling; before the first
                // height message the frame fills the container.
                style={{ height: frameHeight ?? "100%", minHeight: "100%" }}
              />
            )}
          </div>
        ) : (
          /* ── Doc list, grouped by workspace ── */
          <div
            className="flex-1 min-h-0 overflow-y-auto"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {docsError ? (
              <div className="flex flex-col items-center justify-center h-full px-8 gap-3">
                <span className="text-[var(--error)] text-[12px] text-center">{docsError}</span>
                <button
                  onClick={handleRefresh}
                  className="px-4 py-2 border border-[var(--accent-dim)] text-[var(--accent)] text-[12px]"
                >
                  Retry
                </button>
              </div>
            ) : docs === null ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-[var(--text-muted)] text-[12px]">Loading dashboards…</span>
              </div>
            ) : docs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-8 gap-2">
                <span className="text-[var(--text-muted)] text-[13px]">No dashboards yet</span>
                <span className="text-[var(--text-muted)] text-[11px] opacity-60 text-center leading-5">
                  HTML files pinned in a member workspace&rsquo;s file viewer show up here.
                </span>
              </div>
            ) : (
              <div className="py-2 px-1.5 flex flex-col gap-4 pb-6">
                {sections.map((section) => (
                  <div key={section.workspaceId}>
                    <div className="px-3 pb-1.5 text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
                      {section.workspaceName}
                    </div>
                    <div className="flex flex-col gap-2">
                      {section.docs.map((doc) => (
                        <button
                          key={`${doc.workspaceId}:${doc.filePath}`}
                          onClick={() => openDocument(doc)}
                          className="flex items-center gap-3 px-4 py-4 bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-colors text-left w-full"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <div className="text-[var(--text)] text-[12px] font-semibold truncate">
                              {doc.fileName}
                            </div>
                            {doc.agentName && (
                              <div className="text-[var(--text-muted)] text-[10px] truncate mt-0.5">
                                {doc.agentName}
                              </div>
                            )}
                          </div>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-muted)] shrink-0">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
