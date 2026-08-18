import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import {
  GridSocket,
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
import { computeScaleLayout } from "../kessel/scaleLayout";
import {
  applyFrameBatch,
  type CellRun as LiveRun,
  type PendingFrame,
  type TermGridSnapshot as LiveGrid,
} from "../kessel/gridState";
import { TerminalRow, hexToCss, type RenderRun } from "../kessel/rowRender";
import { pickSeamColor } from "../kessel/seamColor";
import {
  contentBoxSize,
  measurePaneFit,
  probeCellMetrics,
} from "../kessel/measurePaneFit";
import {
  initialClaimState,
  reduceClaim,
  pinnedByOther,
  type ClaimEvent,
  type ClaimState,
} from "../lib/claimState";
import {
  anchorScrollPx,
  clampScrollPx,
  computeStripLayout,
} from "../kessel/scrollMath";
import { computeResyncScrollPx } from "../kessel/resyncAnchor";
import {
  accumulateWheelPx,
  canSendSgrWheel,
  cellFromPoint,
  flushWheelNotches,
  initialWheelPump,
} from "../kessel/sgrWheel";
import {
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
  TerminalChrome,
  TerminalCursor,
  SelectionOverlay,
  CopyAffordance,
  ToastPill,
  ClipboardFallbackPill,
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

// ─── Constants ───

// Desktop Kessel defaults (config.ts): Companion keeps its own
// monospace stack; size/line-height come from defaultKesselConfig
// so probeCellMetrics matches the desktop DOM painter.
const FONT_SIZE = 14;
const LINE_HEIGHT_MULT = 1.2;
const FONT_FAMILY = "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace";
const DEFAULT_FG_CSS = hexToCss(DEFAULT_FG);
const DEFAULT_BG_CSS = hexToCss(DEFAULT_BG);
const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

/** One re-fit per keyboard/rotation transition: emit at the END of the
 *  container-resize burst, never per animation frame. */
const REFIT_DEBOUNCE_MS = 250;
/** Matches kessel `scaleLayout` (`container − 4`) and desktop pane
 *  padding (`4px 0 0 4px`). Do not mix with the old 8/4 strip. */
const PAINT_PAD = 4;

function plainRun(text: string): RenderRun {
  return {
    text,
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
    strikeout: false,
  };
}

function toLiveSnapshot(p: TermGridSnapshot): LiveGrid {
  return {
    paneId: p.paneId ?? "",
    cols: p.cols,
    rows: p.rows,
    grid: p.grid as LiveGrid["grid"],
    scrollback: p.scrollback as LiveGrid["scrollback"],
    cursor: p.cursor,
    version: p.version,
    displayOffset: p.displayOffset,
    mouseReport: p.mouseReport,
    sgrMouse: p.sgrMouse,
    altScreen: p.altScreen,
  };
}

function toLiveDelta(p: TermGridDelta): PendingFrame {
  return {
    kind: "delta",
    payload: {
      paneId: p.paneId ?? "",
      cols: p.cols,
      rows: p.rows,
      damagedRows: p.damagedRows,
      scrollbackAppended: p.scrollbackAppended,
      cursor: p.cursor,
      version: p.version,
      displayOffset: p.displayOffset,
    },
  } as PendingFrame;
}

function syncLinesFromSnap(snap: LiveGrid, dest: Map<number, CompactLine>): void {
  dest.clear();
  const push = (abs: number, runs: LiveRun[]) => {
    dest.set(abs, {
      row: abs,
      text: runs.map((r) => r.text).join(""),
      runs: runs.map((r) =>
        r.cols !== undefined ? { text: r.text, cols: r.cols } : { text: r.text },
      ),
      wrapped: runs.some((r) => r.wrapped),
    });
  };
  for (let i = 0; i < snap.scrollback.length; i++) push(i, snap.scrollback[i]);
  const sb = snap.scrollback.length;
  for (let i = 0; i < snap.grid.length; i++) push(sb + i, snap.grid[i]);
}

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
  const cellHRef = useRef(0);
  const [cellW, setCellW] = useState(0);
  const [cellH, setCellH] = useState(0);
  const liveRef = useRef<LiveGrid | null>(null);
  const renderedRef = useRef<LiveGrid | null>(null);
  const [liveSnap, setLiveSnap] = useState<LiveGrid | null>(null);
  const [legacyRows, setLegacyRows] = useState<RenderRun[][]>([]);
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
  const mouseModeRef = useRef<{
    mouseReport: boolean;
    sgrMouse: boolean;
    altScreen: boolean;
  }>({
    mouseReport: false,
    sgrMouse: false,
    altScreen: false,
  });
  // Drive is PR4. Stay false so grid `{action:"input"}` / SGR are
  // no-ops — any Input on a claimer-capable socket is a claim.
  const driveRef = useRef(false);
  // Raw PTY input over the live socket — deliberately NOT the parent's
  // onInputRef path (that's terminal.write, which appends \\r).
  const rawInputRef = useRef<((text: string) => void) | null>(null);
  const wheelPumpRef = useRef(initialWheelPump());
  const wheelRafRef = useRef<number | null>(null);
  const wheelPosRef = useRef({ col: 1, row: 1 });
  const scrollPxRef = useRef(0);
  const [scrollPx, setScrollPx] = useState(0);
  const scrollAccumRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const lastTouchRef = useRef<{ y: number; t: number } | null>(null);
  // Ref mirrors for the bind-once touch handlers (desktop TerminalPane
  // idiom: handlers read refs so the listener never re-binds per frame).
  const gridStateRef = useRef<{ cols: number; viewportRows: number; rows: number }>({
    cols: 0,
    viewportRows: 0,
    rows: 0,
  });
  const layoutRef = useRef<{
    scale: number;
    offsetX: number;
    offsetY: number;
    padX: number;
    padY: number;
  }>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    padX: PAINT_PAD,
    padY: PAINT_PAD,
  });
  const stripLayoutRef = useRef(computeStripLayout(0, 0, 0, 1));

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

  // Same font probe desktop uses (DOM path: raw width, height =
  // ceil(size × config line-height)). Do not keep Companion's old
  // 10px / 1.35 hardcoded metrics.
  useEffect(() => {
    const probed = probeCellMetrics({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      useWebgl: false,
      dpr: window.devicePixelRatio || 1,
      charTracking: 1,
      lineHeightMultiplier: LINE_HEIGHT_MULT,
      configLineHeightMultiplier: LINE_HEIGHT_MULT,
    });
    cellWRef.current = probed.width;
    cellHRef.current = probed.height;
    setCellW(probed.width);
    setCellH(probed.height);
  }, []);

  const scrollbackLoadedRef = useRef(false);

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
    let lastHttpRows: RenderRun[][] = [];
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
        const painted: RenderRun[][] = [];
        for (let i = 0; i < lines.length; i++) {
          const run = plainRun(lines[i]);
          linesRef.current.set(i, { row: i, text: lines[i] });
          painted.push([run]);
        }
        const ch = cellHRef.current || Math.ceil(FONT_SIZE * LINE_HEIGHT_MULT);
        const boxH = containerRef.current?.clientHeight ?? 0;
        const httpVp = Math.max(1, Math.floor(Math.max(0, boxH - PAINT_PAD) / (ch || 1)));
        const sbLen = Math.max(0, painted.length - httpVp);
        if (scrollPxRef.current > 0 && lastHttpRows.length > 0) {
          const prev = {
            scrollback: lastHttpRows,
            grid: [] as RenderRun[][],
            rows: httpVp,
          };
          const next = { scrollback: painted, grid: [] as RenderRun[][], rows: httpVp };
          const re = computeResyncScrollPx(prev, next, scrollPxRef.current, ch);
          const nextPx =
            re !== null
              ? clampScrollPx(re, sbLen, ch)
              : anchorScrollPx(
                  scrollPxRef.current,
                  painted.length - lastHttpRows.length,
                  sbLen,
                  ch,
                );
          scrollPxRef.current = nextPx;
          setScrollPx(nextPx);
        } else {
          scrollPxRef.current = clampScrollPx(scrollPxRef.current, sbLen, ch);
        }
        lastHttpRows = painted;
        setLegacyRows(painted);
        setLiveSnap(null);
        liveRef.current = null;
        renderedRef.current = null;
        setGrid((prev) => ({
          ...prev,
          rows: lines!.length,
          viewportRows: httpVp,
          cursorRow: lines!.length - 1,
          version: Date.now(),
        }));
      }
    };

    // k1 merge lives in gridState.applyFrameBatch (snapshot replace,
    // delta patch, resize-hold blank suppression). The painter is a
    // pure consumer of the resulting live grid.
    const paintLive = (snap: LiveGrid) => {
      liveRef.current = snap;
      renderedRef.current = snap;
      syncLinesFromSnap(snap, linesRef.current);
      scrollbackLoadedRef.current = true;
      setLiveSnap(snap);
      setLegacyRows([]);
      setGrid({
        rows: snap.scrollback.length + snap.grid.length,
        cols: snap.cols,
        viewportRows: snap.rows,
        cursorRow: snap.scrollback.length + snap.cursor.row,
        cursorCol: snap.cursor.col,
        cursorVisible: snap.cursor.visible,
        cursorShape: "block",
        displayOffset: snap.displayOffset,
        version: snap.version,
      });
    };

    const coalescer = createFrameCoalescer<PendingFrame>({
      schedule: (flush) => requestAnimationFrame(flush),
      cancel: (id) => cancelAnimationFrame(id),
      apply: (batch) => {
        const result = applyFrameBatch({
          pending: batch,
          live: liveRef.current,
          rendered: renderedRef.current,
          scrollPx: scrollPxRef.current,
          cellHeight: cellHRef.current || Math.ceil(FONT_SIZE * LINE_HEIGHT_MULT),
          resizeHoldActive: holdRef.current !== null,
        });
        liveRef.current = result.live;
        if (result.scrollPx !== scrollPxRef.current) {
          scrollPxRef.current = result.scrollPx;
          setScrollPx(result.scrollPx);
        }
        const live = result.live;
        if (live && typeof live.mouseReport === "boolean") {
          mouseModeRef.current = {
            mouseReport: live.mouseReport,
            sgrMouse: live.sgrMouse === true,
            altScreen: live.altScreen === true,
          };
        }
        const last = batch[batch.length - 1];
        if (last?.kind === "snapshot") {
          debugRef.current = `ws-snapshot sb=${live?.scrollback.length ?? 0} vp=${live?.grid.length ?? 0}`;
        } else if (last?.kind === "delta") {
          debugRef.current = `ws-delta dmg=${last.payload.damagedRows.length}`;
        }
        const hold = holdRef.current;
        if (hold && live && !result.suppressRender) {
          const atTarget = live.cols === hold.cols && live.rows === hold.rows;
          if (atTarget) {
            holdRef.current = null;
            if (holdTimerRef.current) {
              clearTimeout(holdTimerRef.current);
              holdTimerRef.current = null;
            }
            setPendingResize(null);
          }
        }
        if (!result.suppressRender && live) paintLive(live);
        gridSock.ackApplied(result.ackVersion);
      },
    });

    const onFrame = (frame: GridFrame) => {
      if (frame.event === "snapshot") {
        coalescer.enqueue({
          kind: "snapshot",
          payload: toLiveSnapshot(frame.payload as TermGridSnapshot),
        });
      } else if (frame.event === "delta") {
        coalescer.enqueue(toLiveDelta(frame.payload as TermGridDelta));
      } else if (frame.event === "child_exit") {
        gridSock.close();
      } else if (frame.event === "socket_open") {
        // Ephemeral pins die with their socket: the daemon auto-cleared
        // ours (if any) and told the SURVIVORS — reset local ownership;
        // pin_initial on this connection restores pin truth if any.
        dispatchClaim({ type: "socket_open" });
      } else if (frame.event === "mode") {
        const p = frame.payload as ModePayload;
        // Keep the daemon's real role for chrome. Watch is a local
        // attach policy (no set_active / resize / grid input) — do
        // not forge viewer, that hid Safe send.
        dispatchClaim({
          type: "mode",
          mode: p.mode,
          capable: p.capable,
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
    const companionToken = api.getCompanionToken();
    // Drive is PR4 — omit so the socket flag stays false and SGR
    // input is a no-op even if a handler calls sendInput.
    gridSock.connect(terminalId, {
      route: gridDial.route,
      attach: "watch",
      ...(gridDial.tokenKind === "companion" ? { token: companionToken } : {}),
    });
    driveRef.current = false;
    scrollPxRef.current = 0;
    setScrollPx(0);
    mouseModeRef.current = {
      mouseReport: false,
      sgrMouse: false,
      altScreen: false,
    };
    wheelPumpRef.current = initialWheelPump();

    // Phone-fit for local scale-to-fit only. Watch never emits
    // set_active / resize — Drive is a later PR.
    const measureFit = (): { cols: number; rows: number } | null => {
      return measurePaneFit(
        contentBoxSize(containerRef.current),
        cellWRef.current,
        cellHRef.current,
      );
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

    // Drive is a later PR — Watch never pins / claims / sends
    // grid `{action:"input"}`. Composer stays on terminal.write.
    actionsRef.current = { claim: () => {} };
    // sendInput is Drive-gated on the socket — Watch stays a no-op.
    rawInputRef.current = (text) => gridSock.sendInput(text);
    if (onInputRef) onInputRef.current = null;

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
      if (wheelRafRef.current !== null) {
        cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
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
  }, [terminalId, projectPath, dispatchClaim, applyClipboardText, reloadKey, gridDial]);

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
      const strip = stripLayoutRef.current;
      const g = gridStateRef.current;
      const rect = el.getBoundingClientRect();
      const s = layout.scale > 0 ? layout.scale : 1;
      const localY =
        (clientY - rect.top - layout.padY - layout.offsetY) / s -
        strip.translateY;
      const localX =
        (clientX - rect.left - layout.padX - layout.offsetX) / s;
      return absCellFromPoint({
        x: localX + (layout.padX ?? 0) + layout.offsetX,
        y: localY + strip.stripStart * cellHRef.current + (layout.padY ?? 0),
        offsetX: layout.offsetX,
        scale: 1,
        cellW: cellWRef.current,
        cellH: cellHRef.current,
        cols: g.cols,
        totalRows: g.rows,
        padX: layout.padX,
        padY: layout.padY,
      });
    };

    const cancelWheelRaf = () => {
      if (wheelRafRef.current !== null) {
        cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
    };
    const flushSgrWheel = () => {
      wheelRafRef.current = null;
      if (
        !canSendSgrWheel({
          drive: driveRef.current,
          mouseReport: mouseModeRef.current.mouseReport,
          sgrMouse: mouseModeRef.current.sgrMouse,
        })
      ) {
        return;
      }
      const send = rawInputRef.current;
      const ch = cellHRef.current;
      if (!send || ch <= 0) return;
      const pos = wheelPosRef.current;
      const flushed = flushWheelNotches(
        wheelPumpRef.current,
        ch,
        pos.col,
        pos.row,
      );
      wheelPumpRef.current = flushed.state;
      if (flushed.seq) send(flushed.seq);
    };
    const scheduleSgrFlush = () => {
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(flushSgrWheel);
      }
    };

    const applyLocalScroll = (deltaPx: number) => {
      const scale = layoutRef.current.scale > 0 ? layoutRef.current.scale : 1;
      scrollAccumRef.current += deltaPx / scale;
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const accum = scrollAccumRef.current;
        scrollAccumRef.current = 0;
        if (accum === 0) return;
        const ch = cellHRef.current || Math.ceil(FONT_SIZE * LINE_HEIGHT_MULT);
        const live = liveRef.current;
        const g = gridStateRef.current;
        const sbLen = live
          ? live.scrollback.length
          : Math.max(0, g.rows - g.viewportRows);
        const next = clampScrollPx(scrollPxRef.current - accum, sbLen, ch);
        if (next === scrollPxRef.current) return;
        scrollPxRef.current = next;
        setScrollPx(next);
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
      wheelPumpRef.current = initialWheelPump();
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
      if (gest && !gest.moved) return;
      const last = lastTouchRef.current;
      if (!last) return;
      const deltaPx = last.y - touch.clientY;
      lastTouchRef.current = { y: touch.clientY, t: e.timeStamp };
      if (deltaPx === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sgr = canSendSgrWheel({
        drive: driveRef.current,
        mouseReport: mouseModeRef.current.mouseReport,
        sgrMouse: mouseModeRef.current.sgrMouse,
      });
      if (sgr) {
        const g = gridStateRef.current;
        const cw = cellWRef.current;
        if (cw > 0 && g.viewportRows > 0) {
          const layout = layoutRef.current;
          const rect = el.getBoundingClientRect();
          wheelPosRef.current = cellFromPoint({
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top,
            offsetX: layout.offsetX,
            offsetY: layout.offsetY,
            scale: layout.scale,
            cellW: cw,
            cellH: cellHRef.current,
            cols: g.cols,
            viewportRows: g.viewportRows,
            padX: layout.padX,
            padY: layout.padY,
            scrollPx: scrollPxRef.current,
          });
        }
        wheelPumpRef.current = accumulateWheelPx(wheelPumpRef.current, deltaPx);
        scheduleSgrFlush();
        return;
      }
      // Watch + alt-screen: no SGR (viewer) and no scrollback — no-op.
      if (mouseModeRef.current.altScreen) return;
      applyLocalScroll(deltaPx);
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
      // Tap-mouse (SGR button 0) is a later cut. sendInput only
      // accepts CSI 64/65 — do not inject a click here.
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
      cancelWheelRaf();
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [clearSelection]);

  // Watch-default: never the resize authority. Scale-to-fit with
  // PASSIVE_SCALE_FLOOR 0.40 (pinned floor 0.25). Drive is a later PR.
  const isActiveViewer = false;
  const lineH = cellH || Math.ceil(FONT_SIZE * LINE_HEIGHT_MULT);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const layout = computeScaleLayout({
    snapCols: grid.cols,
    snapRows: grid.viewportRows,
    cellWidth: cellW,
    cellHeight: lineH,
    containerWidth: box.w,
    containerHeight: box.h,
    isActiveViewer,
    pinned: claimState.pin !== null && !(claimState.claimedByMe && pendingResize !== null),
    pendingResize,
  });
  const originX = PAINT_PAD + layout.offsetX;
  const originY = PAINT_PAD + layout.offsetY;

  const allRows: RenderRun[][] = [];
  if (liveSnap) {
    for (const row of liveSnap.scrollback) allRows.push(row);
    for (const row of liveSnap.grid) allRows.push(row);
  } else {
    for (const row of legacyRows) allRows.push(row);
  }

  const totalRows = allRows.length;
  const viewportRows =
    liveSnap?.rows ??
    (grid.viewportRows > 0
      ? grid.viewportRows
      : Math.max(1, Math.floor(Math.max(0, box.h - originY) / (lineH || 1))));
  const strip = computeStripLayout(scrollPx, totalRows, viewportRows, lineH);
  stripLayoutRef.current = strip;

  gridStateRef.current = {
    cols: grid.cols,
    viewportRows,
    rows: totalRows,
  };
  layoutRef.current = {
    scale: layout.scale,
    offsetX: layout.offsetX,
    offsetY: layout.offsetY,
    padX: PAINT_PAD,
    padY: PAINT_PAD,
  };

  const paintRows: { abs: number; row: RenderRun[] }[] = [];
  for (let i = 0; i < strip.rowCount; i++) {
    const abs = strip.stripStart + i;
    paintRows.push({
      abs,
      row: abs < 0 || abs >= totalRows ? [] : allRows[abs],
    });
  }

  const rowElements = paintRows.map(({ abs, row }) => (
    <TerminalRow
      key={abs}
      row={row}
      absRow={abs}
      defaultFg={DEFAULT_FG_CSS}
      defaultBg={DEFAULT_BG_CSS}
      cellWidth={cellW}
      cellHeight={lineH}
      dpr={dpr}
    />
  ));

  const maxRow = totalRows;
  const hasGrid = liveSnap !== null && liveSnap.cols > 0 && cellW > 0;
  const gridW = grid.cols * cellW;
  const visibleRuns = paintRows.map((p) => p.row);
  const seam = liveSnap
    ? pickSeamColor(
        visibleRuns.length > 0 ? visibleRuns : liveSnap.grid,
        liveSnap.cols,
      )
    : null;
  const fontStyles: React.CSSProperties = {
    fontFamily: FONT_FAMILY,
    fontSize: `${FONT_SIZE}px`,
    lineHeight: `${lineH}px`,
    color: DEFAULT_FG_CSS,
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
        background: hexToCss(seam ?? DEFAULT_BG),
      }}
    >
      {/* Native WKWebView scroll stays off. Touch writes scrollPx;
          the strip translates (overscan already mounted). No fling
          in DOM v1 — D6; WebGL pump is PR2b. */}
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
        }}
      >
        {hasGrid ? (
          <div
            style={{
              position: "absolute",
              left: originX,
              top: originY,
              width: gridW * layout.scale,
              height: viewportRows * lineH * layout.scale,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                ...fontStyles,
                width: gridW,
                transform: `scale(${layout.scale})`,
                transformOrigin: "0 0",
              }}
            >
              {DEV_MODE && (
                <div style={{ color: "#22d3ee", fontSize: "9px", padding: "2px 0", opacity: 0.7 }}>
                  {maxRow} lines | {grid.cols}×{grid.viewportRows} | s={layout.scale.toFixed(2)} | px={scrollPx.toFixed(0)}
                  {pendingResize ? ` | hold ${pendingResize.cols}×${pendingResize.rows}` : ""} | {debugRef.current}
                </div>
              )}
              <div
                style={{
                  position: "relative",
                  transform: `translateY(${strip.translateY}px)`,
                  willChange: "transform",
                }}
              >
                {rowElements}
                <TerminalCursor
                  row={grid.cursorRow - strip.stripStart}
                  col={grid.cursorCol}
                  cellW={cellW}
                  lineHeight={lineH}
                  shape={grid.cursorShape}
                  visible={
                    grid.cursorVisible &&
                    grid.cursorRow >= strip.stripStart &&
                    grid.cursorRow < strip.stripStart + strip.rowCount
                  }
                />
                {selection && (
                  <SelectionOverlay
                    segments={selectionRowSegments(
                      normalizeSelection(selection),
                      grid.cols,
                    ).map((seg) => ({
                      ...seg,
                      abs: seg.abs - strip.stripStart,
                    }))}
                    cellW={cellW}
                    lineHeight={lineH}
                  />
                )}
              </div>
            </div>
            {selection && selectionDone && (() => {
              const n = normalizeSelection(selection);
              const left = Math.min(
                Math.max(PAINT_PAD, originX + n.endCol * cellW * layout.scale),
                Math.max(PAINT_PAD, box.w - 88),
              );
              const top =
                originY +
                ((n.endAbs - strip.stripStart + 1) * lineH + strip.translateY) *
                  layout.scale +
                6;
              return (
                <CopyAffordance left={left} top={top} onCopy={handleCopySelection} />
              );
            })()}
          </div>
        ) : (
          <div
            style={{
              ...fontStyles,
              padding: "4px 0 0 4px",
              position: "relative",
              whiteSpace: "pre",
              transform: `translateY(${strip.translateY}px)`,
            }}
          >
            {DEV_MODE && (
              <div style={{ color: "#22d3ee", fontSize: "9px", padding: "2px 0", opacity: 0.7 }}>
                {maxRow} lines | buf={linesRef.current.size} | {grid.rows}r | px={scrollPx.toFixed(0)} | {debugRef.current}
              </div>
            )}
            {rowElements}
          </div>
        )}
      </div>

      {/* Badge/pill strip: claim/claimed/pinned/view-only + the
          "Viewing at C×R" pill. Rendered over the grid, outside the
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
