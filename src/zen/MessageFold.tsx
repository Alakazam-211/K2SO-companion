import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * "See more" for long messages (Rosson 2026-11-06: "If a message is larger
 * than say, 12 rows, can we have it be a 'see more' type experience that
 * expands the message?").
 *
 * A message taller than FOLD_LINES lines of its own text (by rendered
 * height, against the body's computed line-height, so code blocks, lists
 * and headings count by the room they take) shows its first ~14 lines (Rosson: 14, not 12), a
 * fade in the bubble's own colour (`--k2-bubble`) and a "See more" button.
 * Expanded, "See less" folds it again.
 *
 * Layout never moves on its own: collapsed, the clip's max-height is on
 * from the very first paint (FOLD_LINES lines plus one for the button's
 * row), so a long message from the cache, an older page or a streaming
 * reply lays out at its folded height at once; measuring only decides
 * whether the fade and the button (drawn over the clip's last row) show.
 * Only a tap changes the height, and the tap keeps the bubble's top where
 * it was (and, folding, in view).
 */

/** Lines a folded message shows. */
export const FOLD_LINES = 14;
/** The clip holds one row more than it shows: the fade and "See more"
 *  sit on it. A message that fits in FOLD_LINES + 1 lines never folds (a
 *  button that hides one line would cost the line it hides). */
export const FOLD_CLIP_LINES = FOLD_LINES + 1;
/** `.chat-markdown`'s line-height (index.css): the clip's height before
 *  the first measurement, in the body's own `em`. */
const CSS_LINE_EM = 1.5;
/** A bubble's top left above the view (folding back): it comes back with
 *  this much air under the header. */
const VIEW_GAP_PX = 8;

/** Dispatched on any node inside a fold: the fold opens (a search hit in
 *  the hidden part). `revealFolded` sends it. */
export const FOLD_REVEAL_EVENT = "k2-fold-reveal";

/** Open the fold around `node`, if it sits in a folded message. */
export function revealFolded(node: Element): void {
  node.dispatchEvent(new CustomEvent(FOLD_REVEAL_EVENT, { bubbles: true }));
}

/** The clip's height for a line-height, px. */
export function foldClipPx(linePx: number): number {
  return Math.round(linePx * FOLD_CLIP_LINES);
}

/** Taller than the folded clip (half a pixel of rounding aside). */
export function foldable(contentPx: number, linePx: number): boolean {
  return linePx > 0 && contentPx > foldClipPx(linePx) + 0.5;
}

/** A body's computed line-height, px (WebKit resolves a unitless
 *  `line-height` to px; `normal` ≈ 1.2em). 0 when unreadable. */
export function readLinePx(el: Element): number {
  const cs = getComputedStyle(el);
  const raw = cs.lineHeight;
  const font = parseFloat(cs.fontSize);
  if (raw.endsWith("px")) return parseFloat(raw) || 0;
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return Number.isFinite(font) ? n * font : 0;
  return Number.isFinite(font) ? font * 1.2 : 0;
}

/** What the list around the folds lends them: the per-chat memory of
 *  which messages are open (kept while the chat is open; a row the render
 *  window drops comes back as it was), and the scroller's follow, so
 *  opening a message near the newest does not stick the list to the
 *  bottom under the reader. */
export type FoldHost = {
  /** Message keys open now. */
  open: Set<string>;
  scroller(): HTMLElement | null;
  /** Stop sticking to the newest (a fold opening under the reader). */
  unfollow(): void;
  /** Folding back left the view at the newest: follow again. */
  refollow?(): void;
  /** The scroller moved by us (not the reader): its scroll handler skips it. */
  ownScroll?(el: HTMLElement): void;
};

export const FoldContext = createContext<FoldHost | null>(null);

/** A new host: one per open list, stable for its life. */
export function createFoldHost(over: Omit<FoldHost, "open">): FoldHost {
  return { open: new Set<string>(), ...over };
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

/** The px (line-height) the last fold measured: a new fold's clip starts
 *  there (the same body style everywhere), not at the CSS estimate. */
let knownLinePx = 0;
/** Tests: forget the measured line-height. */
export function __resetFoldForTests(): void {
  knownLinePx = 0;
}

export function MessageFold({
  foldKey,
  fontSize,
  reveal,
  children,
}: {
  /** The message's key in its list (the row key). */
  foldKey: string;
  /** The body's font-size (bubbleBodyStyle): the clip's `em` before the
   *  first measurement. */
  fontSize: string;
  /** Landed on (a push tap's / search's highlight): open it. */
  reveal?: boolean;
  children: ReactNode;
}) {
  const host = useContext(FoldContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const clipId = useId();
  const [open, setOpen] = useState(() => host?.open.has(foldKey) ?? false);
  const [linePx, setLinePx] = useState(knownLinePx);
  const [long, setLong] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const longRef = useRef(long);
  longRef.current = long;

  // One observer per fold, on the unclipped words: their full height comes
  // through the clip. Only a crossing (or a new line-height) re-renders;
  // reads happen after layout, in the observer's callback (no thrash).
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries?: ResizeObserverEntry[]) => {
      const e = entries?.[entries.length - 1];
      const h = e?.borderBoxSize?.[0]?.blockSize ?? e?.contentRect?.height ?? inner.offsetHeight;
      const body = inner.querySelector(".chat-markdown") ?? inner;
      const lh = readLinePx(body) || knownLinePx;
      if (lh > 0) {
        knownLinePx = lh;
        setLinePx((cur) => (Math.abs(cur - lh) > 0.25 ? lh : cur));
      }
      setLong(foldable(h, lh));
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  /** Open or fold, the bubble's top kept where it was (folding: kept in
   *  view, or brought back under the header if the reader had scrolled
   *  past it). Measured now; corrected in the commit's layout effect,
   *  before paint. */
  const anchor = useRef<{ row: HTMLElement; sc: HTMLElement; want: number } | null>(null);
  const toggle = (next: boolean) => {
    const root = rootRef.current;
    if (!root || next === openRef.current) return;
    const row = (root.closest("[data-thread-msg], [data-ticket-msg]") as HTMLElement | null) ?? root;
    const sc = host?.scroller() ?? scrollParent(root);
    if (sc) {
      const before = row.getBoundingClientRect().top;
      let want = before;
      if (!next) {
        const view = sc.getBoundingClientRect().top + (parseFloat(getComputedStyle(sc).paddingTop) || 0);
        if (before < view) want = view + VIEW_GAP_PX;
      }
      anchor.current = { row, sc, want };
    }
    // Opening grows the list below the bubble: sticking to the newest
    // would carry its top away. Folding: our own correction decides.
    host?.unfollow();
    if (next) host?.open.add(foldKey);
    else host?.open.delete(foldKey);
    setOpen(next);
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (a) {
      const delta = a.row.getBoundingClientRect().top - a.want;
      if (Math.abs(delta) >= 0.5) {
        a.sc.scrollTop += delta;
        host?.ownScroll?.(a.sc);
      }
    }
    if (a && !open) host?.refollow?.();
  }, [open, host]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // Landed on (a push tap, a search hit): open, once per landing — "See
  // less" while the highlight is still on stays folded.
  const revealed = useRef(false);
  useLayoutEffect(() => {
    if (!reveal) {
      revealed.current = false;
      return;
    }
    if (!long || revealed.current) return;
    revealed.current = true;
    if (!openRef.current) toggleRef.current(true);
  }, [reveal, long]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onReveal = (e: Event) => {
      e.stopPropagation();
      if (!openRef.current && longRef.current) toggleRef.current(true);
    };
    root.addEventListener(FOLD_REVEAL_EVENT, onReveal);
    return () => root.removeEventListener(FOLD_REVEAL_EVENT, onReveal);
  }, []);

  const folded = !open;
  const clipStyle: CSSProperties | undefined = folded
    ? { maxHeight: linePx > 0 ? `${foldClipPx(linePx)}px` : `${FOLD_CLIP_LINES * CSS_LINE_EM}em` }
    : undefined;
  return (
    <div
      ref={rootRef}
      className="zen-fold"
      data-fold={long || open ? (open ? "open" : "folded") : undefined}
      // The body's size, so `em` here (the clip before measuring, the fade,
      // the button) is the words' own; the words set theirs anyway.
      style={{ fontSize, ["--zen-fold-line" as string]: linePx > 0 ? `${linePx}px` : `${CSS_LINE_EM}em` }}
    >
      <div id={clipId} className="zen-fold-clip" style={clipStyle} data-testid="fold-clip">
        <div ref={innerRef} data-testid="fold-inner">
          {children}
        </div>
      </div>
      {folded && long ? <div className="zen-fold-fade" aria-hidden="true" /> : null}
      {long || open ? (
        <button
          type="button"
          className="zen-fold-toggle"
          aria-expanded={open}
          aria-controls={clipId}
          data-testid="fold-toggle"
          onClick={(e) => {
            e.stopPropagation();
            toggle(!open);
          }}
        >
          {open ? "See less" : "See more"}
        </button>
      ) : null}
    </div>
  );
}
