import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import {
  GridSocket,
  GridModel,
  type GridFrame,
  type TermGridSnapshot,
  type TermGridDelta,
  type PinInitialPayload,
  type PinChangedPayload,
  type ModePayload,
  type ColSpanRun,
} from "../api/gridSocket";
import { chooseGridDial, type GridDial } from "../kessel/gridUrl";
import { createFrameCoalescer } from "../lib/frameCoalescer";
import { computeScaleLayout } from "../lib/scaleLayout";
import {
  initialClaimState,
  reduceClaim,
  pinnedByOther,
  type ClaimEvent,
  type ClaimState,
} from "../lib/claimState";
import {
  wheelRoute,
  accumulateDrag,
  initialDragWheel,
  encodeSgrWheel,
  cellFromPoint,
  type DragWheelState,
} from "../lib/sgrWheel";
import {
  mouseRoute,
  encodeSgrTap,
  movedBeyond,
  classifyRelease,
  LONG_PRESS_MS,
} from "../lib/sgrMouse";
import {
  shouldApplyOsc52,
  clipboardTextFromPayload,
  writeClipboard,
} from "../lib/oscClipboard";
import {
  normalizeSelection,
  selectionRowSegments,
  absCellFromPoint,
  type Selection,
} from "../lib/touchSelect";
import { copySelectionText } from "../lib/copyText";
import { useTerminalMetaStore } from "../stores/terminalMeta";
import {
  FixedRow,
  TerminalChrome,
  TerminalCursor,
  SelectionOverlay,
  CopyAffordance,
  ToastPill,
  ClipboardFallbackPill,
  colorToCSS,
  DEFAULT_BG,
  DEFAULT_FG,
  type StyleSpan,
} from "./TerminalGridParts";

// ─── Types ───

interface CompactLine {
  row: number;
  text: string;
  spans?: StyleSpan[];
  wrapped?: boolean;
  /** Per-run column spans (WS path via gridConvert; absent on the
   *  HTTP fallback). Drives the faithful fixed-grid painter. */
  runs?: ColSpanRun[];
}

interface GridUpdate {
  cols: number;
  rows: number;
  cursor_col: number;
  cursor_row: number;
  cursor_visible: boolean;
  cursor_shape: string;
  lines: CompactLine[];
  full: boolean;
  display_offset?: number;
}

// ─── Constants ───

const FONT_SIZE = 10;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.35);
const FONT_FAMILY = "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace";
const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

/** One re-fit per keyboard/rotation transition: emit at the END of the
 *  container-resize burst, never per animation frame. */
const REFIT_DEBOUNCE_MS = 250;

/** Grid-WS claim_pin / pin-size dims bounds (terminal_routes.rs —
 *  out-of-bounds frames are dropped whole, so clamp before sending). */
const PIN_COLS_MIN = 20, PIN_COLS_MAX = 500;
const PIN_ROWS_MIN = 5, PIN_ROWS_MAX = 200;

// ─── Component ───

interface Props {
  terminalId: string;
  projectPath: string;
  // Populated with a function that sends keystrokes/text to THIS session's
  // live grid-WS, so a parent (ChatSession's send bar) can write to the PTY
  // over the same connected socket. Cleared to null on disconnect/unmount.
  onInputRef?: { current: ((text: string) => void) | null };
  // Populated with a function that forces a fresh reconnect of THIS
  // session's grid-WS (tears down + re-opens → new snapshot). Lets a parent
  // (ChatSession's reload button) recover a broken/stale stream.
  onReloadRef?: { current: (() => void) | null };
}

export function TerminalView({ terminalId, projectPath, onInputRef, onReloadRef }: Props) {
  const linesRef = useRef<Map<number, CompactLine>>(new Map());
  const [grid, setGrid] = useState<{
    rows: number;
    cols: number;
    /** PTY viewport rows from the live stream (0 = unknown / HTTP
     *  fallback) — the scale-to-fit grid height. */
    viewportRows: number;
    cursorRow: number;
    cursorCol: number;
    cursorVisible: boolean;
    cursorShape: string;
    displayOffset: number;
    version: number;
  }>({
    rows: 0, cols: 0, viewportRows: 0,
    cursorRow: 0, cursorCol: 0,
    cursorVisible: true, cursorShape: "block",
    displayOffset: 0, version: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const cellWRef = useRef(0);
  const [cellW, setCellW] = useState(0);
  const debugRef = useRef("");
  // Bumping this tears down + recreates the grid-WS (reconnect → fresh
  // snapshot). Driven by the parent's reload button via onReloadRef.
  const [reloadKey, setReloadKey] = useState(0);
  // null = still probing GET /companion/capabilities.
  const [gridDial, setGridDial] = useState<GridDial | null>(null);
  // Container box (border-box px) — the scale-to-fit input. Updated
  // synchronously by the ResizeObserver so keyboard/rotation reflows
  // re-scale immediately (the DIMS emit is what's debounced, not this).
  const [box, setBox] = useState({ w: 0, h: 0 });

  // ── Claim / pin / mode state machine (lib/claimState.ts) ──
  // Ref is the SSOT (event handlers + the socket effect read it
  // synchronously); state mirrors it for render.
  const claimRef = useRef<ClaimState>(initialClaimState);
  const [claimState, setClaimState] = useState<ClaimState>(initialClaimState);
  const dispatchClaim = useCallback((e: ClaimEvent) => {
    claimRef.current = reduceClaim(claimRef.current, e);
    setClaimState(claimRef.current);
  }, []);

  // Mirror mode/claim into the tiny store T3 consumes (input roles).
  useEffect(() => {
    useTerminalMetaStore.getState().set(terminalId, {
      mode: claimState.mode,
      capable: claimState.capable,
      claimedByMe: claimState.claimedByMe,
      pinnedByOther: pinnedByOther(claimState),
    });
  }, [terminalId, claimState]);
  useEffect(
    () => () => useTerminalMetaStore.getState().clear(terminalId),
    [terminalId]
  );

  // ── T5a fullscreen-TUI touch scroll ──
  // Mode bits from the latest k1 snapshot (absent on the JSON path from
  // older daemons → stays "local", scrollback scrolling unchanged).
  // Refs, not state: read inside bind-once touch handlers; nothing
  // repaints when they flip.
  const mouseModeRef = useRef<{ mouseReport: boolean; sgrMouse: boolean }>({
    mouseReport: false,
    sgrMouse: false,
  });
  // Raw PTY input over the live socket — deliberately NOT the parent's
  // onInputRef path (typing re-asserts the size claim; a wheel report
  // must never trigger a resize).
  const rawInputRef = useRef<((text: string) => void) | null>(null);
  const dragWheelRef = useRef<DragWheelState>(initialDragWheel());
  const lastTouchRef = useRef<{ y: number; t: number } | null>(null);
  // Ref mirrors for the bind-once touch handlers (desktop TerminalPane
  // idiom: handlers read refs so the listener never re-binds per frame).
  const gridStateRef = useRef<{ cols: number; viewportRows: number; rows: number }>({
    cols: 0,
    viewportRows: 0,
    rows: 0,
  });
  const layoutRef = useRef<{ scale: number; offsetX: number }>({ scale: 1, offsetX: 0 });

  // ── T5b/T6: gesture classification + selection + clipboard ──
  // One tracker per touch: start point/time, whether it strayed past
  // the tap/long-press movement ceiling, and whether the long-press
  // timer fired (sgrMouse.ts owns the pure disambiguation).
  const gestureRef = useRef<{
    x: number;
    y: number;
    t: number;
    moved: boolean;
    longPress: boolean;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live selection (ref = SSOT for the bind-once handlers, state
  // mirrors for render); `selectionDone` = released, Copy button up.
  const selectionRef = useRef<Selection | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionDone, setSelectionDone] = useState(false);
  // OSC 52 dedupe (desktop oscClipboard parity: claude re-emits the
  // same payload on every repaint while a selection stays live).
  const lastOsc52Ref = useRef<string | null>(null);
  // Clipboard UX: transient "Copied" pill + the WKWebView manual-copy
  // fallback (writeText rejected / unavailable).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clipFallback, setClipFallback] = useState<string | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 1500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    },
    []
  );

  /** OS-clipboard write with the honest WKWebView fallback: silent
   *  rejection → surface the text with a manual Copy button (a button
   *  tap is a fresh user gesture, so the retry usually succeeds). */
  const applyClipboardText = useCallback(
    (text: string) => {
      void writeClipboard(text).then((r) => {
        if (r === "written") showToast("Copied");
        else setClipFallback(text);
      });
    },
    [showToast]
  );

  const clearSelection = useCallback(() => {
    selectionRef.current = null;
    setSelection(null);
    setSelectionDone(false);
  }, []);

  const handleCopySelection = useCallback(() => {
    const sel = selectionRef.current;
    clearSelection();
    if (!sel) return;
    const text = copySelectionText(
      (abs) => linesRef.current.get(abs),
      normalizeSelection(sel)
    );
    if (text) applyClipboardText(text);
  }, [clearSelection, applyClipboardText]);

  // ── Resize hold-and-scale bookkeeping (Kessel parity) ──
  // While a resize/claim we sent is in flight — the container reshaped
  // but incoming frames still carry the OLD cols/rows — the scale
  // layout keeps rendering the last grid stretched/letterboxed to the
  // new box instead of drawing old-geometry content 1:1 and then
  // flashing. Cleared when a NON-BLANK frame at the requested dims
  // lands, or by the timeout (after which we render the truth).
  const holdRef = useRef<{ cols: number; rows: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingResize, setPendingResize] = useState<{ cols: number; rows: number } | null>(null);

  // Socket-effect internals exposed to the chrome's tap handlers.
  const actionsRef = useRef<{ claim: () => void } | null>(null);
  // Last measured phone fit (cols×rows) — the claim button's dims and
  // the drove-the-dims check in the render path.
  const lastFitRef = useRef<{ cols: number; rows: number } | null>(null);

  // Measure cell width once — device-pixel-quantized so N×cellW row
  // widths land on the physical pixel grid (no cumulative subpixel
  // drift across a 500-column row).
  useEffect(() => {
    const span = document.createElement("span");
    span.style.cssText = `font-family: ${FONT_FAMILY}; font-size: ${FONT_SIZE}px; position: absolute; visibility: hidden; white-space: pre;`;
    span.textContent = "W";
    document.body.appendChild(span);
    const raw = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    const dpr = window.devicePixelRatio || 1;
    const quantized = Math.round(raw * dpr) / dpr;
    cellWRef.current = quantized;
    setCellW(quantized);
  }, []);

  const scrollbackLoadedRef = useRef(false);
  const MAX_ROWS = 1000;

  const applyGridUpdate = useCallback(
    (update: GridUpdate, isScrollback = false, viewportRows = 0) => {
      if (update.full && !scrollbackLoadedRef.current) {
        linesRef.current.clear();
      }

      if (isScrollback) {
        // HTTP scrollback — rows map directly by index
        for (const line of update.lines) {
          linesRef.current.set(line.row, line);
        }
      } else {
        // WS grid event — use display_offset for absolute row positioning
        const offset = update.display_offset ?? 0;
        for (const line of update.lines) {
          const absRow = offset + line.row;
          linesRef.current.set(absRow, { ...line, row: absRow });
        }
      }

      // Roll off oldest rows if buffer exceeds max
      if (linesRef.current.size > MAX_ROWS) {
        const keys = Array.from(linesRef.current.keys()).sort((a, b) => a - b);
        const toRemove = keys.length - MAX_ROWS;
        for (let i = 0; i < toRemove; i++) {
          linesRef.current.delete(keys[i]);
        }
      }

      const maxKey = linesRef.current.size > 0
        ? Math.max(...Array.from(linesRef.current.keys())) + 1
        : update.rows;

      setGrid({
        rows: maxKey,
        cols: update.cols,
        viewportRows,
        cursorRow: update.cursor_row,
        cursorCol: update.cursor_col,
        cursorVisible: update.cursor_visible,
        cursorShape: update.cursor_shape?.toLowerCase() || "block",
        displayOffset: update.display_offset ?? 0,
        version: Date.now(),
      });
    },
    []
  );

  // Probe: k1 + companion token → companion grid. Miss → Connect /cli Watch.
  useEffect(() => {
    let cancelled = false;
    setGridDial(null);
    void api.getCompanionCapabilities().then((r) => {
      if (cancelled) return;
      setGridDial(
        chooseGridDial({
          capabilities: r.data,
          companionToken: api.getCompanionToken(),
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  // Live grid stream via the daemon grid-WS.
  useEffect(() => {
    if (gridDial === null) return;
    let polling: ReturnType<typeof setInterval> | null = null;
    let lastText = "";
    let loadingContent = false;

    // HTTP scrollback fallback — used only when the grid-WS can't open
    // (e.g. iOS-device WKWebView WS limitation). Renders text-by-row.
    const loadContent = async () => {
      if (loadingContent) return;
      loadingContent = true;
      let lines: string[] | null = null;
      const r = await api.readTerminal(projectPath, terminalId, 500);
      if (r.ok && r.data?.lines) lines = r.data.lines;
      loadingContent = false;
      if (!lines) return;

      const text = lines.join("\n");
      debugRef.current = `http-lines=${lines.length}`;
      if (text !== lastText) {
        lastText = text;
        scrollbackLoadedRef.current = true;
        linesRef.current.clear();
        for (let i = 0; i < lines.length; i++) {
          linesRef.current.set(i, { row: i, text: lines[i] });
        }
        setGrid((prev) => ({
          ...prev,
          rows: lines!.length,
          viewportRows: 0,
          cursorRow: lines!.length - 1,
          version: Date.now(),
        }));
      }
    };

    // Two-buffer terminal model (GridModel): snapshot replaces the
    // viewport + scrollback; delta patches damaged viewport rows and
    // appends scrollback. `lines()` flattens to absolute-row CompactLines
    // which feed the fixed-grid renderer via applyGridUpdate.
    const model = new GridModel();
    const render = () => {
      const gu: GridUpdate = {
        cols: model.cols,
        rows: model.totalRows(),
        cursor_col: model.cursorCol,
        cursor_row: model.cursorRow(),
        cursor_visible: model.cursorVisible,
        cursor_shape: "block",
        lines: model.lines() as CompactLine[],
        full: true,
        display_offset: 0,
      };
      linesRef.current.clear();
      scrollbackLoadedRef.current = true; // we own the clear above
      applyGridUpdate(gu, true, model.viewport.length);
    };

    // Frame pacing (Kessel parity, frameCoalescer.ts): WS snapshot/delta
    // frames queue and apply once per animation frame — one merge + one
    // render per display refresh, a queued snapshot supersedes everything
    // before it, and the starvation cap flushes synchronously if rAF
    // stalls.
    type PendingFrame =
      | { kind: "snapshot"; payload: TermGridSnapshot }
      | { kind: "delta"; payload: TermGridDelta };
    const coalescer = createFrameCoalescer<PendingFrame>({
      schedule: (flush) => requestAnimationFrame(flush),
      cancel: (id) => cancelAnimationFrame(id),
      apply: (batch) => {
        let maxVersion = 0;
        for (const f of batch) {
          if (f.kind === "snapshot") {
            model.applySnapshot(f.payload);
            // T5a: latest mode bits (k1-only; JSON snapshots leave them
            // unset → local scroll). LIVE by construction — a TUI
            // toggling alt-screen/mouse-reporting mid-session rides the
            // snapshot resend that switch triggers.
            if (typeof f.payload.mouseReport === "boolean") {
              mouseModeRef.current = {
                mouseReport: f.payload.mouseReport,
                sgrMouse: f.payload.sgrMouse === true,
              };
            }
            debugRef.current = `ws-snapshot sb=${model.scrollback.length} vp=${model.viewport.length}`;
          } else {
            model.applyDelta(f.payload);
            debugRef.current = `ws-delta dmg=${f.payload.damagedRows.length}`;
          }
          if (f.payload.version > maxVersion) maxVersion = f.payload.version;
        }
        // Hold-and-scale, apply half: while a resize we sent is in
        // flight, blank merge results park in the model un-rendered
        // (the daemon's cleared-grid intermediate — painting it IS the
        // flash); old-dims content keeps rendering (the scale layout
        // stretches it to the new box); the first non-blank frame at
        // the target dims releases the hold and swaps 1:1.
        const hold = holdRef.current;
        if (hold) {
          const blank = model.viewportBlank();
          const atTarget =
            model.cols === hold.cols && model.viewport.length === hold.rows;
          if (blank) {
            // park — keep the previous DOM until content or timeout
          } else if (atTarget) {
            holdRef.current = null;
            if (holdTimerRef.current) {
              clearTimeout(holdTimerRef.current);
              holdTimerRef.current = null;
            }
            setPendingResize(null);
            render();
          } else {
            render();
          }
        } else {
          render();
        }
        // k1 flow control: one ack per APPLIED batch (applied-to-model,
        // even when the render is parked by the hold), carrying the
        // highest applied version — sent from the rAF flush, never per
        // WS message (ackApplied no-ops until the daemon proves k1).
        gridSock.ackApplied(maxVersion);
      },
    });

    const onFrame = (frame: GridFrame) => {
      if (frame.event === "snapshot") {
        coalescer.enqueue({ kind: "snapshot", payload: frame.payload as TermGridSnapshot });
      } else if (frame.event === "delta") {
        coalescer.enqueue({ kind: "delta", payload: frame.payload as TermGridDelta });
      } else if (frame.event === "child_exit") {
        gridSock.close();
      } else if (frame.event === "socket_open") {
        // Ephemeral pins die with their socket: the daemon auto-cleared
        // ours (if any) and told the SURVIVORS — reset local ownership;
        // pin_initial on this connection restores pin truth if any.
        dispatchClaim({ type: "socket_open" });
      } else if (frame.event === "mode") {
        const p = frame.payload as ModePayload;
        // Connect-owner sockets report claimer. Watch stays viewer;
        // `capable` is kept so Drive (later PR) can opt in. Never
        // promote a mode frame into set_active / resize.
        dispatchClaim({
          type: "mode",
          mode: "viewer",
          capable: p.capable || p.mode === "claimer",
        });
        gridSock.suppressClaim();
      } else if (frame.event === "pin_initial") {
        const p = frame.payload as PinInitialPayload;
        dispatchClaim({ type: "pin_initial", cols: p.cols, rows: p.rows, setBy: p.set_by });
      } else if (frame.event === "pin_changed") {
        const p = frame.payload as PinChangedPayload;
        dispatchClaim({ type: "pin_changed", cols: p.cols, rows: p.rows, cleared: p.cleared });
      } else if (frame.event === "clipboard") {
        // OSC 52 copy from the child app (payload decoded + size-capped
        // daemon-side; read-back is never implemented). Apply only while
        // this connection may drive (claimer) — wezterm's attached-client
        // model, so a phone passively viewing a desktop session never has
        // its clipboard replaced. Dedupe against the last APPLIED value.
        const text = clipboardTextFromPayload(frame.payload);
        if (
          claimRef.current.mode === "claimer" &&
          shouldApplyOsc52(lastOsc52Ref.current, text)
        ) {
          lastOsc52Ref.current = text;
          applyClipboardText(text);
        }
      }
      // title / label_* / bell / error: not consumed yet.
    };

    const gridSock = new GridSocket(onFrame);
    dispatchClaim({ type: "mode", mode: "viewer", capable: true });
    const companionToken = api.getCompanionToken();
    gridSock.connect(terminalId, {
      route: gridDial.route,
      attach: "watch",
      ...(gridDial.tokenKind === "companion" ? { token: companionToken } : {}),
    });

    // ── Phone-fit measurement + emission policy ──
    const measureFit = (): { cols: number; rows: number } | null => {
      const el = containerRef.current;
      const cw = cellWRef.current;
      if (!el || cw <= 0 || el.clientWidth <= 0 || el.clientHeight <= 0) return null;
      // 8px L/R + 4px T/B strip padding; clamped into the daemon's
      // pin/claim bounds (out-of-bounds claim_pin frames drop whole).
      const cols = Math.min(PIN_COLS_MAX, Math.max(PIN_COLS_MIN, Math.floor((el.clientWidth - 16) / cw)));
      const rows = Math.min(PIN_ROWS_MAX, Math.max(PIN_ROWS_MIN, Math.floor((el.clientHeight - 8) / LINE_HEIGHT)));
      return { cols, rows };
    };

    // Measure the phone box for local scale-to-fit. Watch never
    // emits set_active / resize / claim_pin — Drive is a later PR.
    const refit = () => {
      const dims = measureFit();
      if (!dims) return;
      lastFitRef.current = dims;
    };

    // K4: one emit per keyboard/rotation transition — debounce to the
    // END of the container-resize burst. The box STATE updates on every
    // tick (scale-to-fit tracks the animation); only the dims emit
    // waits.
    let refitTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefit = () => {
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => {
        refitTimer = null;
        refit();
      }, REFIT_DEBOUNCE_MS);
    };

    const onBoxChange = () => {
      const el = containerRef.current;
      if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
      debouncedRefit();
    };
    const ro = new ResizeObserver(onBoxChange);
    if (containerRef.current) ro.observe(containerRef.current);
    onBoxChange();
    // Watch-default: do not claim on attach (Connect or companion).
    // Keyboard-height changes ride the container ResizeObserver (the
    // terminal frame is what shrinks), but the native injection's event
    // also nudges the debounce so a transition that ends without a final
    // RO tick still re-fits.
    window.addEventListener("k2-viewport-resize", debouncedRefit);

    // Drive is a later PR — Watch never pins / claims.
    actionsRef.current = { claim: () => {} };

    // Raw input seam for the T5a touch-wheel effect: same connected
    // socket, none of the send bar's reassert-claim behavior below.
    rawInputRef.current = (text: string) => gridSock.sendInput(text);

    // Expose this socket's input to the parent send bar — writes go to the
    // PTY over the SAME connected WS. Typing is "using" the session: if
    // another client drove the dims away while we're claimer + unpinned,
    // re-take the size first (last-claim-wins, the desktop does the same),
    // through the hold so the reflow is smooth. `reassertClaim` forces the
    // send even when our measured dims never changed (claim() dedupes).
    if (onInputRef) {
      onInputRef.current = (text: string) => {
        gridSock.sendInput(text);
      };
    }

    // Expose a reload that forces a fresh reconnect (new snapshot) of this
    // session — bumping reloadKey re-runs this effect.
    if (onReloadRef) onReloadRef.current = () => setReloadKey((k) => k + 1);

    // If the WS hasn't produced a frame shortly after connect, fall back
    // to HTTP polling so the user still sees content on WS-restricted
    // platforms. Cleared automatically once a frame arrives.
    const fallbackTimer = setTimeout(() => {
      if (!gridSock.isOpen && !scrollbackLoadedRef.current) {
        loadContent();
        polling = setInterval(loadContent, 2000);
      }
    }, 1500);

    return () => {
      rawInputRef.current = null;
      if (onInputRef) onInputRef.current = null;
      if (onReloadRef) onReloadRef.current = null;
      actionsRef.current = null;
      ro.disconnect();
      window.removeEventListener("k2-viewport-resize", debouncedRefit);
      if (refitTimer) clearTimeout(refitTimer);
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      holdRef.current = null;
      setPendingResize(null);
      clearTimeout(fallbackTimer);
      gridSock.close();
      if (polling) clearInterval(polling);
      // Cancels any scheduled rAF flush and drops queued frames —
      // nobody left to render them.
      coalescer.clear();
    };
  }, [terminalId, projectPath, applyGridUpdate, dispatchClaim, applyClipboardText, reloadKey, gridDial]);

  // Chrome tap handlers (the socket lives inside the effect; taps go
  // through actionsRef / the HTTP pin route).
  const handleClaimTap = useCallback(() => {
    actionsRef.current?.claim();
  }, []);
  const handleReleaseTap = useCallback(() => {
    // Optimistic; the pin_changed {cleared:true} broadcast confirms.
    dispatchClaim({ type: "release_sent" });
    void api.clearTerminalPin(terminalId);
  }, [dispatchClaim, terminalId]);

  // Auto-scroll to bottom — only if user hasn't scrolled up
  const userScrolledRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      userScrolledRef.current = !atBottom;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (containerRef.current && !userScrolledRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [grid.version]);

  // ── T5a/T5b/T6: the terminal touch-gesture layer ───────────────
  // One movement threshold splits every single-finger touch into
  // exactly one of:
  //   drag       (moved >10px)          → T5a SGR wheel (forward mode)
  //                                       or the native/shim scrollback
  //                                       path (local mode);
  //   long-press (still ≥500ms)         → T6 selection: anchor at the
  //                                       pressed cell, drag adjusts,
  //                                       release shows Copy;
  //   tap        (still, <300ms)        → T5b SGR click (forward mode);
  //                                       clears a finished selection
  //                                       first; in Direct mode the
  //                                       synthetic click that follows
  //                                       keeps the capture focused.
  // Movement cancels the long-press timer; the timer firing takes the
  // touch away from wheel/click; long-press selection wins EVERYWHERE,
  // including over mouse-reporting TUIs (desktop lets selection
  // coexist with forwarding). Binds once; all live state rides refs
  // (mode bits flip per snapshot).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const cancelLongPress = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
    // Touches on the Copy affordance (rendered INSIDE the scroll
    // container so it rides the content) belong to its button, never
    // to the gesture layer.
    const isCopyUi = (t: EventTarget | null) =>
      t instanceof Element && t.closest("[data-k2-copy-ui]") !== null;
    // The finger's ABSOLUTE strip cell (0-based, scrollback included)
    // for selection; null while grid metrics aren't measurable.
    const absCellAt = (clientX: number, clientY: number) => {
      const layout = layoutRef.current;
      const g = gridStateRef.current;
      const rect = el.getBoundingClientRect();
      return absCellFromPoint({
        x: clientX - rect.left + el.scrollLeft,
        y: clientY - rect.top + el.scrollTop,
        offsetX: layout.offsetX,
        scale: layout.scale,
        cellW: cellWRef.current,
        cellH: LINE_HEIGHT,
        cols: g.cols,
        totalRows: g.rows,
      });
    };

    const onTouchStart = (e: TouchEvent) => {
      if (isCopyUi(e.target)) return;
      cancelLongPress();
      // New gesture: fresh cap budget + carry. Multi-touch (pinch) is
      // never ours — drop tracking so a stray move can't emit.
      if (e.touches.length !== 1) {
        lastTouchRef.current = null;
        gestureRef.current = null;
        return;
      }
      const t0 = e.touches[0];
      dragWheelRef.current = initialDragWheel();
      lastTouchRef.current = { y: t0.clientY, t: e.timeStamp };
      gestureRef.current = {
        x: t0.clientX,
        y: t0.clientY,
        t: e.timeStamp,
        moved: false,
        longPress: false,
      };
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const g = gestureRef.current;
        if (!g || g.moved) return;
        const cell = absCellAt(g.x, g.y);
        if (!cell) return; // no measured grid — nothing to select in
        g.longPress = true;
        // A long-press replaces any previous finished selection.
        selectionRef.current = { anchor: cell, focus: cell };
        setSelection(selectionRef.current);
        setSelectionDone(false);
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const gest = gestureRef.current;
      if (gest && !gest.moved && movedBeyond(gest, touch.clientX, touch.clientY)) {
        gest.moved = true; // drag from here — tap and long-press are out
        cancelLongPress();
      }
      // T6 selection drag: after the long-press fired, the finger
      // adjusts the focus cell; the move neither scrolls (shim) nor
      // wheels (forward mode) — the selection owns the rest of the
      // touch.
      if (gest?.longPress && selectionRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const cell = absCellAt(touch.clientX, touch.clientY);
        if (cell) {
          selectionRef.current = {
            anchor: selectionRef.current.anchor,
            focus: cell,
          };
          setSelection(selectionRef.current);
        }
        return;
      }
      // T5a wheel path (forward mode only). NORMAL mode returns before
      // preventDefault, so the existing scrollback path (native scroll
      // + ChatSession's touchmove→scrollTop shim) is untouched.
      if (wheelRoute(mouseModeRef.current) !== "forward") return;
      // Pre-classification stillness: inside the tap/long-press
      // movement ceiling nothing wheels yet — a tick here would make a
      // pending long-press ALSO scroll the TUI.
      if (gest && !gest.moved) return;
      // Input gate: viewer / not-capable connections' input frames are
      // dropped server-side — don't send them at all.
      const s = claimRef.current;
      if (s.mode !== "claimer" || !s.capable) return;
      const send = rawInputRef.current;
      const last = lastTouchRef.current;
      const g = gridStateRef.current;
      const cw = cellWRef.current;
      // Metrics/stream not ready → leave the drag to the local path
      // (desktop parity: its wheel branch requires measured cells).
      if (!send || !last || cw <= 0 || g.viewportRows <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      const deltaPx = last.y - touch.clientY; // >0 = finger up = wheel-down
      const dtMs = Math.max(1, e.timeStamp - last.t);
      lastTouchRef.current = { y: touch.clientY, t: e.timeStamp };
      if (deltaPx === 0) return;
      const layout = layoutRef.current;
      const rect = el.getBoundingClientRect();
      const cell = cellFromPoint({
        x: touch.clientX - rect.left + el.scrollLeft,
        y: touch.clientY - rect.top + el.scrollTop,
        offsetX: layout.offsetX,
        scale: layout.scale,
        cellW: cw,
        cellH: LINE_HEIGHT,
        cols: g.cols,
        viewportRows: g.viewportRows,
        totalRows: g.rows,
      });
      const r = accumulateDrag(
        dragWheelRef.current,
        deltaPx,
        LINE_HEIGHT * (layout.scale > 0 ? layout.scale : 1),
        Math.abs(deltaPx) / dtMs,
      );
      dragWheelRef.current = r.state;
      // Ticks of one move batch into ONE WS message (desktop's
      // seq.repeat(ticks) flush parity).
      if (r.ticks > 0) {
        send(encodeSgrWheel(r.dir, cell.col, cell.row).repeat(r.ticks));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      lastTouchRef.current = null;
      cancelLongPress();
      const gest = gestureRef.current;
      gestureRef.current = null;
      if (!gest || isCopyUi(e.target)) return;
      const kind = classifyRelease({
        moved: gest.moved,
        longPressFired: gest.longPress,
        durationMs: e.timeStamp - gest.t,
      });
      if (kind === "long-press") {
        // Selection finalized — show the Copy affordance; swallow the
        // synthetic click (Direct-mode tap-to-focus must not fire off
        // a selection release).
        if (selectionRef.current) {
          setSelectionDone(true);
          if (e.cancelable) e.preventDefault();
        }
        return;
      }
      if (kind !== "tap") return;
      // Tap with a selection up: clear it (tap-elsewhere-clears) and
      // consume the tap — it neither clicks nor focuses.
      if (selectionRef.current) {
        clearSelection();
        if (e.cancelable) e.preventDefault();
        return;
      }
      // T5b SGR tap-to-click: same gate as the wheel branch. Legacy
      // scrollback mode taps stay local (Direct-mode focus etc.).
      if (mouseRoute(mouseModeRef.current) !== "forward") return;
      const s = claimRef.current;
      if (s.mode !== "claimer" || !s.capable) return;
      const send = rawInputRef.current;
      const cw = cellWRef.current;
      const g = gridStateRef.current;
      if (!send || cw <= 0 || g.viewportRows <= 0) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const layout = layoutRef.current;
      const rect = el.getBoundingClientRect();
      const cell = cellFromPoint({
        x: touch.clientX - rect.left + el.scrollLeft,
        y: touch.clientY - rect.top + el.scrollTop,
        offsetX: layout.offsetX,
        scale: layout.scale,
        cellW: cw,
        cellH: LINE_HEIGHT,
        cols: g.cols,
        viewportRows: g.viewportRows,
        totalRows: g.rows,
      });
      send(encodeSgrTap(cell.col, cell.row));
      // Deliberately NO preventDefault: the synthetic click that
      // follows still fires, so in Direct mode over a mouse-reporting
      // TUI the tap BOTH clicks the TUI and keeps the hidden capture
      // focused (ChatSession's wrapper onClick).
    };

    const onTouchCancel = () => {
      lastTouchRef.current = null;
      cancelLongPress();
      const gest = gestureRef.current;
      gestureRef.current = null;
      // A cancelled long-press drag still finalizes — iOS fires cancel
      // on system gestures mid-selection; losing it would be hostile.
      if (gest?.longPress && selectionRef.current) setSelectionDone(true);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      cancelLongPress();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [clearSelection]);

  // ── Scale-to-fit layout (lib/scaleLayout.ts, Kessel port) ──
  // "Active" = our resizes drive the PTY right now: claimer, unpinned
  // by others, and either the frames already track OUR fit or a resize
  // we sent is in flight (hold-and-scale). Anything else (desktop drove
  // the dims, pinned elsewhere, viewer) scales-to-fit. While our OWN
  // ephemeral re-claim is in flight the pinned branch yields to the
  // active hold path so keyboard reflows stretch instead of snapping.
  const lastFit = lastFitRef.current;
  const drivenByUs =
    lastFit !== null &&
    grid.cols === lastFit.cols &&
    grid.viewportRows === lastFit.rows;
  const isActiveViewer =
    claimState.mode === "claimer" &&
    !pinnedByOther(claimState) &&
    (drivenByUs || pendingResize !== null);
  const layout = computeScaleLayout({
    snapCols: grid.cols,
    snapRows: grid.viewportRows,
    cellWidth: cellW,
    cellHeight: LINE_HEIGHT,
    availWidth: box.w - 16,
    availHeight: box.h - 8,
    isActiveViewer,
    pinned: claimState.pin !== null && !(claimState.claimedByMe && pendingResize !== null),
    pendingResize,
  });

  // Mirror the render-scope values the bind-once T5a touch handlers
  // read (grid dims for the SGR cell, scale for row quantization).
  gridStateRef.current = {
    cols: grid.cols,
    viewportRows: grid.viewportRows,
    rows: grid.rows,
  };
  layoutRef.current = { scale: layout.scale, offsetX: layout.offsetX };

  // Fixed 1:1 grid needs live-stream dims + measured metrics; the HTTP
  // fallback (bare text rows, unknown cols) keeps the legacy wrap block.
  const fixedGrid = grid.cols > 0 && grid.viewportRows > 0 && cellW > 0;

  // Build row elements — render all buffered lines for scrollback
  const rowElements: React.ReactNode[] = [];
  const maxRow = Math.max(grid.rows, linesRef.current.size, ...Array.from(linesRef.current.keys()).map(k => k + 1));
  if (fixedGrid) {
    for (let r = 0; r < maxRow; r++) {
      rowElements.push(
        <FixedRow
          key={r}
          line={linesRef.current.get(r)}
          cols={grid.cols}
          cellW={cellW}
          lineHeight={LINE_HEIGHT}
        />
      );
    }
  } else {
    for (let r = 0; r < maxRow; r++) {
      const line = linesRef.current.get(r);
      rowElements.push(
        <div key={r} style={{ minHeight: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}>
          {line?.text || " "}
        </div>
      );
    }
  }

  const gridW = grid.cols * cellW;
  const stripH = maxRow * LINE_HEIGHT;
  const fontStyles: React.CSSProperties = {
    fontFamily: FONT_FAMILY,
    fontSize: `${FONT_SIZE}px`,
    color: colorToCSS(DEFAULT_FG),
    fontVariantLigatures: "none",
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: "hidden",
        background: colorToCSS(DEFAULT_BG),
      }}
    >
      {/* Scroll container — MUST stay `overflow: auto` (ChatSession's
          touch-scroll shim finds it by that inline style). Native
          vertical scroll through the scrollback strip is preserved;
          the scale transform below never hijacks it. */}
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {fixedGrid ? (
          // Sizing shell: transforms don't affect layout, so this div
          // carries the SCALED strip footprint (scroll geometry), and
          // the inner block paints the 1:1 grid scaled about its
          // top-left. offsetX centers/letterboxes horizontally;
          // vertical stays top-anchored — the scroll axis IS the
          // letterbox there.
          <div
            style={{
              position: "relative",
              width: Math.max(box.w, gridW * layout.scale + 16),
              height: stripH * layout.scale + 8,
            }}
          >
            <div
              style={{
                ...fontStyles,
                position: "absolute",
                left: 8 + layout.offsetX,
                top: 4,
                width: gridW,
                transform: `scale(${layout.scale})`,
                transformOrigin: "0 0",
              }}
            >
              {DEV_MODE && (
                <div style={{ color: "#22d3ee", fontSize: "9px", padding: "2px 0", opacity: 0.7 }}>
                  {maxRow} lines | {grid.cols}×{grid.viewportRows} | s={layout.scale.toFixed(2)}
                  {pendingResize ? ` | hold ${pendingResize.cols}×${pendingResize.rows}` : ""} | {debugRef.current}
                </div>
              )}
              {/* Rows + the session's own cursor share one relative
                  box so the cursor's row math ignores the DEV debug
                  line above (T4: the PTY cursor IS the typing caret). */}
              <div style={{ position: "relative" }}>
                {rowElements}
                <TerminalCursor
                  row={grid.cursorRow}
                  col={grid.cursorCol}
                  cellW={cellW}
                  lineHeight={LINE_HEIGHT}
                  shape={grid.cursorShape}
                  visible={grid.cursorVisible}
                />
                {/* T6 selection highlight — grid space, so the scale
                    transform and the rows' coordinate math apply
                    unchanged. */}
                {selection && (
                  <SelectionOverlay
                    segments={selectionRowSegments(
                      normalizeSelection(selection),
                      grid.cols
                    )}
                    cellW={cellW}
                    lineHeight={LINE_HEIGHT}
                  />
                )}
              </div>
            </div>
            {/* T6 Copy affordance — near the selection tail, UNSCALED
                (outside the transformed strip) so it stays finger-sized;
                inside the scroll container so it rides the content. */}
            {selection && selectionDone && (() => {
              const n = normalizeSelection(selection);
              const left = Math.min(
                Math.max(8, 8 + layout.offsetX + n.endCol * cellW * layout.scale),
                Math.max(8, box.w - 88)
              );
              const top = 4 + (n.endAbs + 1) * LINE_HEIGHT * layout.scale + 6;
              return (
                <CopyAffordance left={left} top={top} onCopy={handleCopySelection} />
              );
            })()}
          </div>
        ) : (
          // HTTP fallback / pre-stream: legacy wrap block.
          <div
            style={{
              ...fontStyles,
              padding: "4px 8px",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
            }}
          >
            {DEV_MODE && (
              <div style={{ color: "#22d3ee", fontSize: "9px", padding: "2px 0", opacity: 0.7 }}>
                {maxRow} lines | buf={linesRef.current.size} | {grid.rows}r | {debugRef.current}
              </div>
            )}
            {rowElements}
          </div>
        )}
      </div>

      {/* Badge/pill strip: claim/claimed/pinned/view-only + the
          "viewing at C×R" pill. Rendered over the grid, outside the
          scroll flow. */}
      <TerminalChrome
        claim={claimState}
        passive={layout.passive}
        gridCols={grid.cols}
        gridRows={grid.viewportRows}
        onClaim={handleClaimTap}
        onRelease={handleReleaseTap}
      />

      {/* T5b/T6 clipboard UX — transient "Copied" pill; when WKWebView
          rejects the write (no user gesture behind an OSC 52 frame),
          the fallback pill surfaces the text with a manual Copy (a
          fresh gesture, so the retry usually succeeds). */}
      {toast && <ToastPill text={toast} />}
      {clipFallback !== null && (
        <ClipboardFallbackPill
          text={clipFallback}
          onCopy={() => {
            const t = clipFallback;
            setClipFallback(null);
            void writeClipboard(t).then((r) => {
              if (r === "written") showToast("Copied");
              else setClipFallback(t);
            });
          }}
          onDismiss={() => setClipFallback(null)}
        />
      )}
    </div>
  );
}
