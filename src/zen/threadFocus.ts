import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useZenStore } from "./zenStore";

/** Query key a push tap adds to `/zen?addr=`: the message to land on. */
export const ZEN_SEQ_PARAM = "seq";
/** At most this many "Load earlier" pages while looking for the seq. */
export const FOCUS_MAX_PAGES = 4;
/** How long the landed message stays highlighted. */
export const FOCUS_HIGHLIGHT_MS = 2000;

/** A positive integer seq from the query, or null. */
export function zenFocusSeq(raw: string | null | undefined): number | null {
  const s = (raw || "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Find `threadFocusSeq` in the open Thread: scroll it into the middle and
 *  highlight it briefly. Not loaded yet and older than the oldest row →
 *  `loadEarlier` page by page (capped). Gone or newer than the tail →
 *  give up quietly and stay at the newest. Returns the highlighted seq. */
export function useThreadFocusSeq(scrollerRef: RefObject<HTMLElement | null>): number | null {
  const focusSeq = useZenStore((s) => s.threadFocusSeq);
  const thread = useZenStore((s) => s.thread);
  const source = useZenStore((s) => s.threadSource);
  const hasMore = useZenStore((s) => s.threadHasMore);
  const loadingEarlier = useZenStore((s) => s.threadLoadingEarlier);
  const [highlight, setHighlight] = useState<number | null>(null);
  const pages = useRef(0);

  useEffect(() => {
    pages.current = 0;
  }, [focusSeq]);

  // Layout effect, declared after ThreadPane's stick-to-newest, so it wins.
  useLayoutEffect(() => {
    if (focusSeq == null || source !== "live" || loadingEarlier) return;
    const done = () => useZenStore.setState({ threadFocusSeq: null });
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      setHighlight(focusSeq);
      done();
      return;
    }
    if (!thread.length) {
      done();
      return;
    }
    const oldest = thread[0]?.seq ?? null;
    if (oldest != null && focusSeq < oldest && hasMore && pages.current < FOCUS_MAX_PAGES) {
      pages.current += 1;
      void useZenStore.getState().loadEarlier();
      return;
    }
    done();
  }, [focusSeq, thread, source, hasMore, loadingEarlier, scrollerRef]);

  useEffect(() => {
    if (highlight == null) return;
    const t = setTimeout(() => setHighlight(null), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  return highlight;
}
