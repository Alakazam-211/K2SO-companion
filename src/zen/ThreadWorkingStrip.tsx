import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import {
  COUNTER_CHECK_PX,
  COUNTER_GAP_PX,
  COUNTER_GROUP_GAP_PX,
  COUNTER_ICON_GAP_PX,
  COUNTER_ICON_PX,
  COUNTER_SPINNER_EM,
  STOPPED_LINGER_MS,
  counterSpoken,
  counterWidthPx,
  estimateStripTextPx,
  fitStripCounters,
  threadDrawerLine,
  type StripCounter,
  type StripCounterKey,
  type ThreadDrawerLine,
  type ThreadStripStep,
  type ThreadStripTone,
} from "./threadStrip";
import {
  AgentIcon,
  CheckIcon,
  CogIcon,
  FileIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  type IconProps,
} from "./icons";
import type { ThreadTurn } from "./threadTurn";
import { zenTextPx } from "./zenFont";
import { prefersReducedMotion } from "./sendFly";
import "./threadDrawer.css";

// The Thread working drawer: a glass tile pulled out of the composer's top
// edge (GlassComposer's `drawer` slot owns where it sits) while
// the agent works on your message, so it stays in view while you read
// back. Collapsed it is one line (pulse · step · icon counters · clock);
// a tap grows it upward to the full detail in words, another tap shrinks
// it back. The choice is remembered per device. Nothing else is stored.
// It counts its own clock (1 Hz, from the daemon's `startedAt` /
// `phaseSince`, corrected by `serverNow`), so the list does not re-render
// every second. Words: `threadDrawerLine` / `threadStripView`.

const TONE: Record<ThreadStripTone, string> = {
  working: "var(--success)",
  monitoring: "var(--accent)",
  "needs-you": "var(--warning)",
  stopped: "var(--text-muted)",
  unverifiable: "var(--text-muted)",
};

/** Slide / fade length (ms); the CSS uses the same. */
export const DRAWER_MS = 200;
/** Collapsed tile height (px) above the field, top rim included. */
export const DRAWER_TILE_PX = 32;
/** The slot's vars (GlassComposer); the fallbacks keep it whole alone. */
const TUCK = "var(--k2-drawer-tuck, 0px)";
const RADIUS = "var(--k2-drawer-radius, 15px)";
/** Room the step keeps before counters start dropping. */
const STEP_MIN_PX = 72;
const COUNTER_FONT_PX = 12;
const EXPANDED_LINE_PX = 19;
/** Each counter is a borderless tinted tag: side padding (px) and height. */
export const TAG_PAD_X_PX = 5;
export const TAG_H_PX = 18;

/** Each counter's icon: the app's own, reused (`./icons`). */
export const STRIP_ICON: Record<StripCounterKey, ComponentType<IconProps>> = {
  subagents: AgentIcon,
  background: CogIcon,
  read: FileIcon,
  search: SearchIcon,
  cmd: TerminalIcon,
  edit: PencilIcon,
};

/** A counter's tag width (px): its glyphs plus the tag's side padding. */
export function counterTagWidthPx(c: StripCounter, fontPx = COUNTER_FONT_PX): number {
  return counterWidthPx(c, fontPx) + 2 * TAG_PAD_X_PX;
}

/** Braille spinner frames (desktop `.braille-spinner`), 80ms each. */
export const BRAILLE_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Reduced motion: one still glyph in the spinner's place. */
export const SPINNER_STATIC = "•";

/** Icons sit on the text baseline: their middle at the digits' middle. */
const ON_BASELINE = { verticalAlign: "-0.2em", marginRight: COUNTER_ICON_GAP_PX } as const;

function BrailleSpinner({ still }: { still: boolean }) {
  const box = { width: `${COUNTER_SPINNER_EM}em`, verticalAlign: "-0.15em" };
  if (still) {
    return (
      <span className="k2-braille-spinner" data-testid="thread-strip-spinner" data-static="true" style={box}>
        {SPINNER_STATIC}
      </span>
    );
  }
  return (
    <span className="k2-braille-spinner" data-testid="thread-strip-spinner" style={box}>
      <span>
        {Array.from(BRAILLE_FRAMES).map((f, i) => (
          <span key={i} className="block">
            {f}
          </span>
        ))}
      </span>
    </span>
  );
}

/** One collapsed counter's visible part (aria-hidden; the words are beside it). */
function CounterGlyphs({ c, still }: { c: StripCounter; still: boolean }) {
  const Glyph = STRIP_ICON[c.key];
  const icon = <Glyph size={COUNTER_ICON_PX} strokeWidth={2} className="inline-block" style={ON_BASELINE} />;
  if (c.key !== "subagents") {
    return (
      <span aria-hidden="true">
        {icon}
        {c.count}
      </span>
    );
  }
  // [agent] ⠋1  ✓2: the agent icon labels both groups.
  return (
    <span aria-hidden="true">
      {icon}
      {c.count > 0 ? (
        <span data-testid="thread-strip-running">
          <BrailleSpinner still={still} />
          {c.count}
        </span>
      ) : null}
      {c.done > 0 ? (
        <span
          data-testid="thread-strip-done"
          style={{ marginLeft: c.count > 0 ? COUNTER_GROUP_GAP_PX : 0 }}
        >
          <CheckIcon size={COUNTER_CHECK_PX} strokeWidth={2.4} className="inline-block" style={ON_BASELINE} />
          {c.done}
        </span>
      ) : null}
    </span>
  );
}

export const DRAWER_EXPANDED_KEY = "k2-zen-thread-drawer-expanded";

export function readDrawerExpanded(): boolean {
  try {
    return localStorage.getItem(DRAWER_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDrawerExpanded(on: boolean): void {
  try {
    localStorage.setItem(DRAWER_EXPANDED_KEY, on ? "1" : "0");
  } catch {
    /* private mode / quota: the choice lasts this session only */
  }
}

/** A tool line: backtick spans become code. */
function StepText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          // A neutral tag like the counters': filled, no border (threadDrawer.css).
          <code key={i} data-testid="thread-strip-code" className="k2-drawer-tag k2-drawer-code font-mono text-[0.92em]">
            {p}
          </code>
        ) : (
          <span key={i}>{i % 2 === 1 ? `\`${p}` : p}</span>
        )
      )}
    </>
  );
}

function StepBody({ step }: { step: ThreadStripStep }) {
  return step.kind === "line" ? <StepText text={step.text} /> : <>{step.text}</>;
}

function useStripNow(turn: ThreadTurn | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!turn) return;
    if (turn.end === null) {
      const id = setInterval(() => setNow(Date.now()), 1_000);
      return () => clearInterval(id);
    }
    if (turn.end.reason === "interrupted") {
      const left = turn.end.at + STOPPED_LINGER_MS - (Date.now() + turn.skewMs);
      if (left <= 0) return;
      const id = setTimeout(() => setNow(Date.now()), left + 50);
      return () => clearTimeout(id);
    }
  }, [turn]);
  return now;
}

/** Counter budget (px) for a collapsed tile `width` wide showing `clock`. */
export function counterBudget(width: number, clock: string): number {
  if (!Number.isFinite(width) || width <= 0) return Infinity;
  // px-3 both sides, the 8px pulse, three 8px gaps, the clock, the step's floor.
  return width - 24 - 8 - 24 - estimateStripTextPx(clock, COUNTER_FONT_PX) - STEP_MIN_PX;
}

type Phase = "hidden" | "in" | "out";

export function ThreadWorkingStrip({
  turn,
  onSpace,
}: {
  turn: ThreadTurn | null;
  /** Height (px) the drawer stands above the composer field: 0 when
   *  hidden or leaving. The Thread pads its scroller by what it covers. */
  onSpace?: (px: number) => void;
}) {
  const now = useStripNow(turn);
  const line = turn ? threadDrawerLine(turn, now) : null;
  const shown = line !== null;
  const last = useRef<ThreadDrawerLine | null>(line);
  if (line) last.current = line;

  // hidden → in (slide up) → out (slide down) → hidden.
  const [phase, setPhase] = useState<Phase>(shown ? "in" : "hidden");
  if (shown && phase !== "in") setPhase("in");
  if (!shown && phase === "in") setPhase("out");
  useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(() => setPhase("hidden"), DRAWER_MS + 60);
    return () => clearTimeout(t);
  }, [phase]);

  const [expanded, setExpanded] = useState(readDrawerExpanded);
  const toggle = () => {
    setExpanded((on) => {
      writeDrawerExpanded(!on);
      return !on;
    });
  };

  // Measure: the tile's width (which counters fit) and the content's
  // height (the tile animates to it; the Thread pads by it).
  const tileRef = useRef<HTMLButtonElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [innerH, setInnerH] = useState(0);
  const display = line ?? (phase === "out" ? last.current : null);
  const mounted = display !== null;
  useLayoutEffect(() => {
    if (!mounted) return;
    const measure = () => {
      setWidth(tileRef.current?.clientWidth ?? 0);
      setInnerH(innerRef.current?.offsetHeight ?? 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    if (tileRef.current) ro.observe(tileRef.current);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, [mounted, expanded]);

  const detailLines = display
    ? 1 +
      (display.detail.step ? 1 : 0) +
      (display.detail.tally ? 1 : 0) +
      (display.detail.children ? 1 : 0)
    : 0;
  // Visible height: content plus the top rim (no bottom rim: the field's
  // top edge is the seam). The tucked part behind the field is extra.
  const tileH =
    innerH > 0
      ? innerH + 1
      : expanded
        ? 12 + 1 + detailLines * EXPANDED_LINE_PX
        : DRAWER_TILE_PX;
  const space = phase === "in" ? tileH : 0;
  const onSpaceRef = useRef(onSpace);
  onSpaceRef.current = onSpace;
  useLayoutEffect(() => {
    onSpaceRef.current?.(space);
  }, [space]);
  useEffect(() => () => onSpaceRef.current?.(0), []);

  if (!display) return null;
  const reduced = prefersReducedMotion();
  const anim =
    phase === "out"
      ? reduced
        ? "k2-drawer-fade-out"
        : "k2-drawer-slide-out"
      : reduced
        ? "k2-drawer-fade-in"
        : "k2-drawer-slide-in";
  const color = TONE[display.tone];
  const pulsing = display.tone === "working";
  const counters = fitStripCounters(display.counters, counterBudget(width, display.clock), (c) =>
    counterTagWidthPx(c)
  );
  const dot = (
    <span
      aria-hidden
      className={`relative inline-block flex-none w-2 h-2 rounded-full box-border ${pulsing ? "k2-pulse" : ""}`}
      style={
        display.tone === "monitoring" || display.tone === "stopped" || display.tone === "unverifiable"
          ? { border: `2px solid ${color}` }
          : { background: color, color }
      }
    />
  );
  const d = display.detail;

  return (
    // Rendered into GlassComposer's drawer slot: its clip box ends under
    // the field's top edge, so the tile slides out of (and back into) the
    // field. Only the tile takes touches.
    <div
      role="status"
      data-testid="thread-working-strip"
      data-tone={display.tone}
      data-phase={turn?.phase}
      data-leaving={phase === "out" ? "true" : undefined}
      data-expanded={expanded ? "true" : "false"}
      className={anim}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && phase === "out") setPhase("hidden");
      }}
    >
      <button
        ref={tileRef}
        type="button"
        data-testid="thread-strip-toggle"
        aria-expanded={expanded}
        aria-label={display.ariaLabel}
        // Keep focus in the composer so a tap does not drop the iOS
        // keyboard (the send bubble's trick). Enter/Space still click.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className="k2-tile k2-tile-sheet k2-drawer-tile relative block w-full min-w-0 overflow-hidden text-left pointer-events-auto"
        style={{
          height: innerH > 0 ? `calc(${innerH + 1}px + ${TUCK})` : undefined,
          paddingBottom: TUCK,
          borderRadius: `${RADIUS} ${RADIUS} 0 0`,
          borderStyle: display.tone === "unverifiable" ? "dashed" : undefined,
          transition: reduced ? "none" : undefined,
        }}
      >
        <span
          ref={innerRef}
          className={`${innerH > 0 ? "absolute left-0 right-0" : ""} block min-w-0`}
          style={innerH > 0 ? { bottom: TUCK } : undefined}
        >
          {expanded ? (
            <span data-testid="thread-strip-detail" className="flex flex-col gap-[1px] px-3 py-1.5 min-w-0">
              <span className="flex items-center gap-2 min-w-0 text-[13px] leading-[18px]">
                {dot}
                <span
                  data-testid="thread-strip-head"
                  className="min-w-0 font-semibold break-words"
                  style={{ color }}
                >
                  {d.head}
                </span>
              </span>
              {d.step ? (
                <span
                  data-testid="thread-strip-step-full"
                  className="flex items-baseline gap-2 min-w-0 leading-[19px]"
                  style={{ color: "var(--text)", fontSize: zenTextPx(14) }}
                >
                  <span
                    className={`flex-1 min-w-0 whitespace-normal break-words ${
                      d.step.kind === "thinking" ? "k2-shimmer" : ""
                    }`}
                    style={d.step.kind === "needs" ? { color: "var(--warning)" } : undefined}
                  >
                    <StepBody step={d.step} />
                  </span>
                  {d.step.elapsed ? (
                    <span
                      data-testid="thread-strip-elapsed"
                      className="flex-none tabular-nums text-[12px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {d.step.elapsed}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {d.tally ? (
                <span
                  data-testid="thread-strip-tally"
                  className="min-w-0 break-words text-[12px] leading-[18px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {d.tally}
                </span>
              ) : null}
              {d.children ? (
                <span
                  data-testid="thread-strip-children"
                  className="min-w-0 break-words text-[12px] leading-[18px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {d.children}
                </span>
              ) : null}
            </span>
          ) : (
            <span
              data-testid="thread-strip-line"
              className="flex items-center gap-2 min-w-0 px-3 whitespace-nowrap"
              style={{ height: DRAWER_TILE_PX - 1 }}
            >
              {dot}
              <span
                data-testid="thread-strip-step-text"
                className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[18px] ${
                  display.step.kind === "thinking" ? "k2-shimmer" : ""
                }`}
                style={{
                  fontSize: zenTextPx(13),
                  color:
                    display.step.kind === "needs"
                      ? "var(--warning)"
                      : display.tone === "stopped" || display.tone === "unverifiable"
                        ? "var(--text-muted)"
                        : "var(--text)",
                }}
              >
                <StepBody step={display.step} />
              </span>
              {counters.length ? (
                <span
                  data-testid="thread-strip-counters"
                  className="flex-none flex items-center tabular-nums text-[12px] leading-[18px]"
                  style={{ gap: COUNTER_GAP_PX }}
                >
                  {/* One tag per counter, tinted by kind (threadDrawer.css). */}
                  {counters.map((c) => (
                    <span
                      key={c.key}
                      data-testid={`thread-strip-count-${c.key}`}
                      data-tag={c.key}
                      className={`k2-drawer-tag k2-drawer-count k2-drawer-tag-${c.key}`}
                      style={{ height: TAG_H_PX, paddingLeft: TAG_PAD_X_PX, paddingRight: TAG_PAD_X_PX }}
                    >
                      <CounterGlyphs c={c} still={reduced} />
                      <span className="sr-only">{counterSpoken(c)}</span>
                    </span>
                  ))}
                </span>
              ) : null}
              <span
                data-testid="thread-strip-since"
                className="flex-none tabular-nums text-right text-[12px] leading-[18px]"
                style={{ color: "var(--text-muted)" }}
              >
                {display.clock}
              </span>
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
