// Keyboard-drag replay: feeds a trace's native timeline (keyboard top +
// list scroll per frame, the finger's touches, the lift and the Will*)
// through the real page logic — keyboardDragDock (touch-crossing attach,
// sample correction) and useViewportHeight (drag start, release
// hand-off) — under fake timers, then models where the composer is drawn
// each frame and scores it with kbDragScore (same score as on device).
//
// Needs a jsdom test environment (`// @vitest-environment jsdom`).
//
// What is modelled, per native frame t:
//   - the list's scroll: the trace's native scrollY (UI process truth);
//     the PAGE sees it `pageLagFrames` late (rects / scrollTop) — the web
//     process lag the sample correction exists for;
//   - the shell's samples: the kb_sampler rules (lib.rs) pick which
//     frames are posted; each arrives `ipcFrames` later;
//   - the composer drawn: before the attach the dock at the column bottom;
//     attached, the copy in the content (its style.top + height − native
//     scroll + its eased transform); released, the composer's FLIP play
//     from the motion's `from` to `to` on its duration / curve (ThreadPane
//     draws the dock at final − (to − from)·(1 − ease)).

import { createElement, useEffect, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { vi } from "vitest";
import {
  __resetViewportForTests,
  useViewport,
  useViewportPadRef,
  useViewportTrackRef,
  type ViewportMotion,
} from "../lib/useViewportHeight";
import {
  installKeyboardDragDock,
  setKeyboardDragObserver,
} from "../zen/keyboardDragDock";
import { scoreTrace, type KbEvent, type KbScore, type KbTrace } from "../lib/kbDragScore";
import { easingFn } from "./kbSynth";

export type ReplayOptions = {
  /** Frames between a native sample and the page seeing it. */
  ipcFrames?: number;
  /** Frames the page's view of the scroll trails the UI process. */
  pageLagFrames?: number;
};

export type ReplayResult = { score: KbScore; trace: KbTrace };

/** kb_sampler (lib.rs) in TS: which native frames get posted. */
export function sampledFrames(samples: KbTrace["samples"], from: number, until: number): number[] {
  const EARLY = 4;
  const LATE_MS = 100;
  const out: number[] = [];
  let rest: number | null = null;
  let moveStart: number | null = null;
  let early = 0;
  let late = false;
  for (let i = 0; i < samples.length; i++) {
    const [t, top] = samples[i];
    if (t < from || t >= until) continue;
    if (rest == null) rest = top;
    if (Math.abs(top - rest) >= 0.5) {
      if (moveStart == null) moveStart = t;
      if (early < EARLY) {
        early++;
        out.push(i);
      } else if (!late && t - moveStart >= LATE_MS) {
        late = true;
        out.push(i);
      }
    } else {
      moveStart = null;
      early = 0;
      late = false;
    }
  }
  return out;
}

type Segment = { start: number; from: number; to: number; ms: number; ease: (p: number) => number };
const valueAt = (s: Segment | null, t: number) =>
  !s ? 0 : s.ms <= 0 ? s.to : s.from + (s.to - s.from) * s.ease(Math.min(1, Math.max(0, (t - s.start) / s.ms)));

const BASE = 1_800_000_000_000;

export function replayTrace(trace: KbTrace, opts: ReplayOptions = {}): ReplayResult {
  const ipc = opts.ipcFrames ?? 1;
  const lag = opts.pageLagFrames ?? 1;
  const viewH = trace.viewH ?? Math.max(...trace.samples.map((s) => s[1]));
  const rest = trace.restTop;
  const dockH = trace.padding > 0 ? trace.padding : 64;
  const frame = 1000 / (trace.refreshHz || 60);
  const samples = trace.samples;
  const scrollAt = (i: number) => samples[Math.max(0, Math.min(samples.length - 1, i))][2] ?? 0;

  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"],
  });
  vi.setSystemTime(BASE);
  // The store's sub-ms wall clock (performance.timeOrigin + now).
  let clockNow = 0;
  const perfNow = vi.spyOn(performance, "now").mockImplementation(() => clockNow);
  const origin = Object.getOwnPropertyDescriptor(performance, "timeOrigin");
  Object.defineProperty(performance, "timeOrigin", { configurable: true, value: BASE });
  const w = window as unknown as Record<string, unknown>;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewH });
  const vv = Object.assign(new EventTarget(), { height: viewH, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  w.__k2KeyboardSetup = true;
  __resetViewportForTests();

  let pageScroll = scrollAt(0);
  const els: Record<string, HTMLElement | null> = {};
  let liveMotion: ViewportMotion | null = null;
  function Thread() {
    const { height, motion, interactive } = useViewport();
    liveMotion = motion;
    const col = useViewportTrackRef();
    const pad = useViewportPadRef();
    const scroller = useRef<HTMLDivElement>(null);
    const dock = useRef<HTMLDivElement>(null);
    const layer = useRef<HTMLDivElement>(null);
    useEffect(
      () =>
        installKeyboardDragDock({
          scroller: () => scroller.current,
          dock: () => dock.current,
          layer: () => layer.current,
          padding: () => dockH,
        }),
      []
    );
    return createElement(
      "div",
      {
        "data-testid": "col",
        ref: col,
        // As Zen's thread column.
        style: {
          height: interactive ? viewH : motion && motion.to < motion.from ? motion.from : height,
        },
      },
      createElement(
        "div",
        { "data-testid": "scroller", ref: scroller },
        createElement("div", { "data-testid": "layer", ref: layer }),
        createElement("div", { "data-testid": "pad", ref: pad })
      ),
      createElement("div", { "data-testid": "dock", ref: dock }, createElement("textarea"))
    );
  }

  // Captured page events (trace-relative ms).
  let now = 0;
  const events: KbEvent[] = [];
  let attached = false;
  let released: { at: number; from: number } | null = null;
  setKeyboardDragObserver({
    attached: (via) => {
      attached = true;
      events.push({ t: now, k: "attach", via });
    },
    corrected: (d, ms) => events.push({ t: now, k: "correct", d, ms }),
    released: (fromTop, copyBottom) => {
      events.push({ t: now, k: "release", fromTop, copyBottom: copyBottomTrue ?? copyBottom });
    },
    detached: () => {
      attached = false;
    },
  });
  let copyBottomTrue: number | null = null;

  try {
    render(createElement(Thread));
    const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    els.col = q("col");
    els.scroller = q("scroller");
    els.layer = q("layer");
    els.dock = q("dock");
    const colH = () => parseFloat(els.col!.style.height) || viewH;
    els.dock!.getBoundingClientRect = () => rectOf(colH() - dockH, dockH);
    els.layer!.getBoundingClientRect = () => rectOf(-pageScroll, 0);
    Object.defineProperty(els.scroller!, "scrollTop", { configurable: true, get: () => pageScroll });

    // Keyboard up and settled at the trace's rest.
    act(() => {
      (w.__k2KeyboardWill as (d: unknown) => void)({
        height: viewH - rest,
        duration: 250,
        curve: 7,
        show: true,
      });
    });
    vv.height = rest;
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const t0 = 400;
    vi.setSystemTime(BASE + t0);
    clockNow = t0;

    // Timeline.
    const touches = trace.events.filter((e) => e.k === "touch") as Extract<KbEvent, { k: "touch" }>[];
    const lift = trace.events.find((e) => e.k === "lift");
    const will = trace.events.find((e) => e.k === "will") as Extract<KbEvent, { k: "will" }> | undefined;
    const panFrom = touches[0]?.t ?? 0;
    const panUntil = will ? will.t : Number.POSITIVE_INFINITY;
    const posted = new Set(sampledFrames(samples, panFrom, panUntil));
    const deliveries = [...posted].map((i) => ({ at: samples[i][0] + ipc * frame, i }));
    const willAt = will ? will.t + ipc * frame : null;
    const kbAt = (tt: number) => {
      let best = samples[0][1];
      for (const s of samples) {
        if (s[0] <= tt) best = s[1];
        else break;
      }
      return best;
    };
    let touchIdx = 0;
    let started = false;
    let lifted = false;
    let willDone = false;
    let transformSeg: Segment | null = null;
    let lastTransform = "";
    let colSeg: Segment | null = null;
    const page: KbTrace["page"] = [];

    const touch = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true }) as TouchEvent;
      Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
      Object.defineProperty(e, "changedTouches", { value: [{ clientY: y }] });
      act(() => {
        els.scroller!.dispatchEvent(e);
      });
    };
    const standIn = () => els.layer!.querySelector<HTMLElement>('[data-testid="thread-composer-standin"]');
    const noteTransform = () => {
      const s = standIn();
      if (!s) return;
      if (s.style.transform === lastTransform) return;
      lastTransform = s.style.transform;
      const m = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(s.style.transform);
      const to = m ? Number(m[1]) : 0;
      const tm = /transform (\d+)ms (.+)$/.exec(s.style.transition);
      transformSeg = {
        start: now,
        from: valueAt(transformSeg, now),
        to,
        ms: tm ? Number(tm[1]) : 0,
        ease: easingFn(tm ? tm[2] : "linear"),
      };
    };

    for (let i = 0; i < samples.length; i++) {
      const tt = samples[i][0];
      now = tt;
      act(() => {
        vi.setSystemTime(BASE + t0 + tt);
        clockNow = t0 + tt;
        vi.advanceTimersByTime(0);
      });
      pageScroll = scrollAt(i - lag);
      const sNow = scrollAt(i);
      // Touches up to this frame.
      while (touchIdx < touches.length && touches[touchIdx].t <= tt + 1e-6) {
        const y = touches[touchIdx].y;
        if (!started) {
          touch("touchstart", y);
          started = true;
        }
        touch("touchmove", y);
        touchIdx++;
      }
      if (lift && !lifted && lift.t <= tt + 1e-6) {
        touch("touchend", touches[touches.length - 1]?.y ?? 0);
        lifted = true;
      }
      // Native samples arriving now.
      for (const d of deliveries) {
        if (d.at > tt - frame + 1e-6 && d.at <= tt + 1e-6) {
          const [st, top, sy] = samples[d.i];
          act(() => {
            (w.__k2KeyboardSample as (s: unknown) => void)({ top, scrollY: sy, t: BASE + t0 + st });
          });
          noteTransform();
        }
      }
      // The copy as drawn (before a release this frame).
      const s = standIn();
      copyBottomTrue = s
        ? parseFloat(s.style.top) + parseFloat(s.style.height) - sNow + valueAt(transformSeg, tt)
        : null;
      // The Will* arriving now: the hand-off.
      if (will && willAt != null && !willDone && willAt <= tt + 1e-6) {
        willDone = true;
        const fromTop = kbAt(will.t);
        const wasAttached = attached;
        act(() => {
          (w.__k2KeyboardWill as (d: unknown) => void)({
            height: will.show ? viewH - rest : 0,
            duration: will.ms,
            curve: 7,
            show: will.show,
            at: BASE + t0 + will.t,
            fromTop,
          });
        });
        if (wasAttached) {
          const m = liveMotion as ViewportMotion | null;
          released = { at: tt, from: m ? m.from : fromTop };
          colSeg = m
            ? { start: tt - m.elapsed, from: m.from, to: m.to, ms: m.ms, ease: easingFn(m.easing) }
            : { start: tt, from: fromTop, to: will.show ? rest : viewH, ms: 0, ease: (p) => p };
        }
      }
      // Where the composer is drawn this frame.
      let bottom: number;
      if (released && colSeg) bottom = valueAt(colSeg, tt);
      else if (standIn()) bottom = copyBottomTrue as number;
      else bottom = colH();
      page.push([Math.round(tt * 10) / 10, Math.round(bottom * 100) / 100, Math.round(pageScroll * 10) / 10]);
    }
    void released;

    const out: KbTrace = { ...trace, page, events: [...trace.events, ...events].sort((a, b) => a.t - b.t) };
    return { score: scoreTrace(out), trace: out };
  } finally {
    perfNow.mockRestore();
    if (origin) Object.defineProperty(performance, "timeOrigin", origin);
    else delete (performance as unknown as Record<string, unknown>).timeOrigin;
    setKeyboardDragObserver(null);
    cleanup();
    __resetViewportForTests();
    delete w.__k2KeyboardSetup;
    vi.useRealTimers();
  }
}

function rectOf(top: number, height: number): DOMRect {
  return {
    top,
    height,
    left: 0,
    width: 390,
    bottom: top + height,
    right: 390,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect;
}
