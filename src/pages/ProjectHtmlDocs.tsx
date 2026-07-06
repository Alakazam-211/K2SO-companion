// Slice C2 — the HTML dashboards browser (PRD §2): the project's pinned
// HTML docs (`/cli/project-group/html-docs`, grouped by workspace),
// tapped open in a SANDBOXED iframe (`srcDoc`, `sandbox="allow-scripts"`
// — no same-origin, no navigation, no popups) fed by
// `/cli/fs/read-file`.
//
// MOBILE SCROLL (docs/ios-keyboard-layout.md): the app disables the
// WKWebView's MAIN scroll view (a single setScrollEnabled:false on
// `wk.scrollView` in src-tauri/src/lib.rs — not recursive), so the
// top-level page can't scroll natively. Composited INNER scrollers are
// unaffected — every overflow:auto container in the app already
// scrolls with native momentum. So the viewer keeps the iframe fixed
// to the viewport and makes the DOCUMENT INSIDE it scroll: a style
// block appended to the fetched HTML turns <body> into an
// overflow:auto scroller (both axes — wide dashboards pan
// horizontally too), which rides that same proven machinery. Native
// momentum, no JS in the loop. (An earlier version forwarded touch
// deltas over postMessage and scrolled a parent container — per-event
// JS scrolling has no inertia and was visibly choppy on iOS.)
//
// The sandbox stays intact: `sandbox="allow-scripts"` srcDoc, no
// same-origin, no navigation, and no bridge at all anymore — the
// former height/scroll postMessage channel (and its nonce) is gone.
//
// Full-screen overlay (same rationale as ProjectChat: the /chat/:id
// chrome-hiding behavior without editing the shared nav components).

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchFileContent,
  fetchProjectGroupHtmlDocs,
  type ProjectGroupHtmlDoc,
} from "../api/projectGroups";
import { useServersStore } from "../stores/servers";
import { groupHtmlDocsByWorkspace } from "../lib/projectChat";

/** Appended to every fetched doc so the document scrolls INSIDE the
 *  viewport-sized iframe with native momentum. Appended last so it
 *  wins the cascade against the doc's own equal-specificity html/body
 *  rules; a doc that pins these with !important is managing its own
 *  scrolling and keeps doing so. html is clipped (and body margin
 *  zeroed) so body is the one scroller — no double scrollbars. */
const DOC_SCROLL_STYLE =
  "<style>" +
  "html{height:100%;overflow:hidden}" +
  "body{height:100%;margin:0;overflow:auto;" +
  "-webkit-overflow-scrolling:touch;overscroll-behavior:contain}" +
  "</style>";

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
      setBody(r.data.content);
    } else {
      setBody(null);
      setBodyError(r.error ?? "Failed to read file");
    }
  }, []);

  const openDocument = (doc: ProjectGroupHtmlDoc) => {
    setOpenDoc(doc);
    setBody(null);
    void loadBody(doc);
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    if (openDoc) await loadBody(openDoc);
    else await loadDocs();
    setRefreshing(false);
  };

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
          /* ── Viewer: iframe pinned to the viewport; the DOCUMENT
             inside it scrolls (native momentum, both axes) ── */
          <div className="flex-1 min-h-0 overflow-hidden">
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
                srcDoc={body + DOC_SCROLL_STYLE}
                // Fills the viewer exactly; overflow lives inside the
                // document, which owns scrolling on both axes.
                className="block w-full h-full border-0 bg-white"
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
