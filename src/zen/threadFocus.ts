import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useZenStore } from "./zenStore";

/** Query key a push tap adds to `/zen?addr=`: the message to land on. */
export const ZEN_SEQ_PARAM = "seq";
/** At most this many "Load earlier" pages while looking for the seq. */
export const FOCUS_MAX_PAGES = 4;
/** How long the landed message stays highlighted. */
export const FOCUS_HIGHLIGHT_MS = 2000;
/** A target missing from the cached (unconfirmed) copy waits at most this
 *  long for the server's read before it is given up on. */
export const FOCUS_WAIT_MS = 5000;

/** A positive integer seq from the query, or null. */
export function zenFocusSeq(raw: string | null | undefined): number | null {
  const s = (raw || "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Find `threadFocusSeq` in the open Thread: scroll it into the middle and
 *  highlight it briefly. Missing from a cached copy the server has not
 *  confirmed yet (a push for a message newer than the cache) → wait for
 *  the read (or delta) to land, up to `FOCUS_WAIT_MS`. Not loaded yet and
 *  older than the oldest row → `loadEarlier` page by page (capped). Gone
 *  or newer than the tail → give up quietly (`onGiveUp`: back to the
 *  newest). Returns the highlighted seq. */
export function useThreadFocusSeq(
  scrollerRef: RefObject<HTMLElement | null>,
  onGiveUp?: () => void
): number | null {
  const focusSeq = useZenStore((s) => s.threadFocusSeq);
  const thread = useZenStore((s) => s.thread);
  const source = useZenStore((s) => s.threadSource);
  const cached = useZenStore((s) => s.threadCached);
  const hasMore = useZenStore((s) => s.threadHasMore);
  const loadingEarlier = useZenStore((s) => s.threadLoadingEarlier);
  const [highlight, setHighlight] = useState<number | null>(null);
  // The seq whose wait for a confirmed copy ran out.
  const [expired, setExpired] = useState<number | null>(null);
  const pages = useRef(0);
  const giveUpRef = useRef(onGiveUp);
  giveUpRef.current = onGiveUp;

  useEffect(() => {
    pages.current = 0;
  }, [focusSeq]);

  // Waiting on an unconfirmed copy: bounded.
  const waiting = focusSeq != null && cached && expired !== focusSeq;
  useEffect(() => {
    if (!waiting || focusSeq == null) return;
    const seq = focusSeq;
    const t = setTimeout(() => setExpired(seq), FOCUS_WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting, focusSeq]);

  // Layout effect, declared after ThreadPane's stick-to-newest, so it wins.
  useLayoutEffect(() => {
    if (focusSeq == null || loadingEarlier) return;
    // Loading (or the first paint held for the read): wait. A failed read
    // is as confirmed as it gets: look in what is shown, else give up.
    if (source !== "live" && source !== "error") return;
    const done = () => useZenStore.setState({ threadFocusSeq: null });
    const giveUp = () => {
      done();
      giveUpRef.current?.();
    };
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      setHighlight(focusSeq);
      done();
      return;
    }
    // The cached copy may simply be behind: the server's copy decides.
    if (source === "live" && cached && expired !== focusSeq) return;
    if (!thread.length || source === "error") {
      giveUp();
      return;
    }
    const oldest = thread[0]?.seq ?? null;
    if (oldest != null && focusSeq < oldest && hasMore && pages.current < FOCUS_MAX_PAGES) {
      pages.current += 1;
      void useZenStore.getState().loadEarlier();
      return;
    }
    giveUp();
  }, [focusSeq, thread, source, cached, expired, hasMore, loadingEarlier, scrollerRef]);

  useEffect(() => {
    if (highlight == null) return;
    const t = setTimeout(() => setHighlight(null), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  return highlight;
}
