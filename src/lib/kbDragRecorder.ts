// Keyboard drag recorder (diagnostics). Off by default; when off it costs
// one localStorage read at startup and nothing else — no listeners, no
// observer, and the native shell keeps its normal idle sampler.
//
// On (Server settings → Diagnostics → "Keyboard drag recorder", or the
// dev console: `__k2KbRecorder.on()`), every interactive-dismiss drag in
// the Thread (attach → release → keyboard settled, ≤ TRACE_CAP_MS) is
// recorded:
//   - native, per display frame while the drag is sampled and through the
//     release animation: keyboard top + the list's contentOffset.y + wall
//     clock (`__k2KeyboardRec`, lib.rs);
//   - page, per rAF: the composer's bottom (copy while attached, real dock
//     after), the list's scrollTop; and the attach / correction / release
//     / Will* / touch events.
// Then it is scored (kbDragScore.ts) and the last MAX_TRACES are kept
// (localStorage, best effort) for the Diagnostics screen.
//
// Clocks: native posts wall-clock ms (SystemTime); the page converts with
// performance.timeOrigin (same system wall clock). Residual: the wall
// clock can be slewed/stepped after the page loaded (measured per trace as
// |Date.now() − performance.now() − timeOrigin|, + 0.5 ms for Date.now's
// 1 ms resolution → `clockErrMs`), and the native read is the display
// link callback (frame start), not the frame's presentation — a constant
// part-frame bias the gap does not see, since both keyboard and composer
// are compared per page frame.

import {
  TRACE_CAP_MS,
  TRACE_VERSION,
  isTrace,
  scoreTrace,
  type KbEvent,
  type KbScore,
  type KbTrace,
} from "./kbDragScore";
import { keyboardTopNow } from "./useViewportHeight";
import {
  composerBottomNow,
  dismissPaddingPx,
  setKeyboardDragObserver,
  type KeyboardDragObserver,
} from "../zen/keyboardDragDock";

const PREF_KEY = "k2.kbDragRecorder.v1";
const TRACES_KEY = "k2.kbDragTraces.v1";
/** Traces kept. */
export const MAX_TRACES = 6;
/** Native frames kept from before the attach (ms). */
const PRE_ATTACH_MS = 300;
/** A detach with no release ends the trace after this (ms) unless it
 *  re-attaches. */
const DETACH_END_MS = 1000;
/** After a Will*: keep recording its animation + this (ms). */
const AFTER_WILL_MS = 200;

export type RecordedDrag = { trace: KbTrace; score: KbScore };

let on = readPref();
let installed = false;
let drags: RecordedDrag[] = loadTraces();
const subs = new Set<() => void>();

function readPref(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function loadTraces(): RecordedDrag[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TRACES_KEY) : null;
    if (!raw) return [];
    const xs = JSON.parse(raw) as unknown[];
    return xs.filter(isTrace).map((trace) => ({ trace, score: scoreTrace(trace) }));
  } catch {
    return [];
  }
}

function saveTraces(): void {
  try {
    localStorage.setItem(TRACES_KEY, JSON.stringify(drags.map((d) => d.trace)));
  } catch {
    /* quota / private mode: memory only */
  }
}

function emit(): void {
  for (const fn of [...subs]) fn();
}

export function subscribeRecorder(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function recorderOn(): boolean {
  return on;
}

/** Newest first. */
export function recordedDrags(): RecordedDrag[] {
  return drags;
}

export function clearRecordedDrags(): void {
  drags = [];
  saveTraces();
  emit();
}

export function setRecorderOn(next: boolean): void {
  on = next;
  try {
    if (next) localStorage.setItem(PREF_KEY, "1");
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* session only */
  }
  if (next) install();
  else uninstall();
  emit();
}

async function syncNative(enabled: boolean): Promise<void> {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ios_keyboard_recorder", { on: enabled });
  } catch {
    /* not the iOS shell */
  }
}

// ── A session (one drag) ─────────────────────────────────────────────

type Session = {
  /** Page time (performance.now) the trace's t=0 maps to. */
  t0: number;
  restTop: number;
  padding: number;
  clockErrMs: number;
  samples: [number, number, number | null][];
  page: [number, number, number][];
  events: KbEvent[];
  endAt: number;
  frame: number | null;
};

let session: Session | null = null;
/** Native frames before an attach (page-clock ms). */
let preRoll: [number, number, number | null][] = [];

const r1 = (n: number) => Math.round(n * 10) / 10;

function nowMs(): number {
  return performance.now();
}

/** Native wall-clock ms → page performance.now() ms. */
function nativeToPage(t: number): number {
  const origin = performance.timeOrigin;
  if (typeof origin === "number" && Number.isFinite(origin) && origin > 0) return t - origin;
  return t - (Date.now() - performance.now());
}

function clockErr(): number {
  const origin = performance.timeOrigin;
  if (!(typeof origin === "number" && origin > 0)) return 1;
  return r1(Math.abs(Date.now() - performance.now() - origin) + 0.5);
}

function scrollTopNow(): number {
  const el = document.querySelector<HTMLElement>('[data-testid="thread-scroller"]');
  return el ? el.scrollTop : 0;
}

/** An event without its time (distributes over the union). */
type EventIn = KbEvent extends infer E ? (E extends KbEvent ? Omit<E, "t"> : never) : never;

function event(e: EventIn & { t?: number }): void {
  if (!session) return;
  const t = r1((e.t ?? nowMs()) - session.t0);
  session.events.push({ ...(e as KbEvent), t });
}

function startSession(via: "touch" | "sample"): void {
  const now = nowMs();
  if (session) {
    session.endAt = now + TRACE_CAP_MS; // re-attached: carry on
    event({ k: "attach", via });
    return;
  }
  const t0 = now - PRE_ATTACH_MS;
  session = {
    t0,
    restTop: r1(keyboardTopNow() ?? 0),
    padding: dismissPaddingPx(),
    clockErrMs: clockErr(),
    samples: preRoll.filter(([t]) => t >= t0).map(([t, top, sy]) => [r1(t - t0), top, sy]),
    page: [],
    events: [],
    endAt: now + TRACE_CAP_MS,
    frame: null,
  };
  preRoll = [];
  event({ k: "attach", via });
  tick();
}

function tick(): void {
  if (!session) return;
  const now = nowMs();
  const bottom = composerBottomNow();
  if (bottom != null) session.page.push([r1(now - session.t0), r1(bottom), r1(scrollTopNow())]);
  if (now >= session.endAt || now - session.t0 >= TRACE_CAP_MS + PRE_ATTACH_MS) {
    finish();
    return;
  }
  session.frame = requestAnimationFrame(tick);
}

function refreshHzOf(page: [number, number, number][]): number {
  const ds: number[] = [];
  for (let i = 1; i < page.length; i++) ds.push(page[i][0] - page[i - 1][0]);
  if (!ds.length) return 60;
  ds.sort((a, b) => a - b);
  const med = ds[ds.length >> 1];
  return med > 0 ? Math.round(1000 / med) : 60;
}

function deviceInfo(): { device: string; ios: string; dpr: number } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const m = /OS (\d+)[_.](\d+)/.exec(ua);
  const device = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : "other";
  return { device, ios: m ? `${m[1]}.${m[2]}` : "", dpr: window.devicePixelRatio || 1 };
}

function finish(): void {
  const s = session;
  if (!s) return;
  session = null;
  if (s.frame != null) cancelAnimationFrame(s.frame);
  s.events.push({ t: r1(nowMs() - s.t0), k: "end" });
  const trace: KbTrace = {
    v: TRACE_VERSION,
    ...deviceInfo(),
    refreshHz: refreshHzOf(s.page),
    restTop: s.restTop,
    viewH: window.innerHeight,
    padding: s.padding,
    clockErrMs: s.clockErrMs,
    samples: s.samples,
    page: s.page,
    events: s.events,
  };
  drags = [{ trace, score: scoreTrace(trace) }, ...drags].slice(0, MAX_TRACES);
  saveTraces();
  emit();
}

const obs: KeyboardDragObserver = {
  attached: (via) => startSession(via),
  corrected: (d, ms) => event({ k: "correct", d: r1(d), ms }),
  released: (fromTop, copyBottom) =>
    event({
      k: "release",
      fromTop: fromTop == null ? null : r1(fromTop),
      copyBottom: copyBottom == null ? null : r1(copyBottom),
    }),
  detached: () => {
    if (!session) return;
    const releasing = session.events.some((e) => e.k === "release");
    if (!releasing) session.endAt = Math.min(session.endAt, nowMs() + DETACH_END_MS);
  },
};

function onRec(e: Event): void {
  const d = (e as CustomEvent<{ t?: number; top?: number; scrollY?: number | null }>).detail;
  if (!d || typeof d.top !== "number" || typeof d.t !== "number") return;
  const t = nativeToPage(d.t);
  const sy = typeof d.scrollY === "number" ? r1(d.scrollY) : null;
  if (session) {
    session.samples.push([r1(t - session.t0), r1(d.top), sy]);
  } else {
    preRoll.push([t, r1(d.top), sy]);
    const cut = t - PRE_ATTACH_MS;
    while (preRoll.length && preRoll[0][0] < cut) preRoll.shift();
  }
}

function onWill(e: Event): void {
  if (!session) return;
  const d = (e as CustomEvent<{ show?: boolean; duration?: number }>).detail;
  const ms = typeof d?.duration === "number" ? d.duration : 250;
  event({ k: "will", show: !!d?.show, ms: Math.round(ms) });
  session.endAt = Math.min(session.endAt, nowMs() + ms + AFTER_WILL_MS);
}

function onTouch(e: TouchEvent): void {
  if (!session) return;
  const t = e.touches[0];
  if (t) event({ k: "touch", y: r1(t.clientY) });
}

function onLift(): void {
  if (session) event({ k: "lift" });
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  setKeyboardDragObserver(obs);
  (window as unknown as { __k2KeyboardRec?: (d: unknown) => void }).__k2KeyboardRec ??= (d) =>
    window.dispatchEvent(new CustomEvent("k2-keyboard-rec", { detail: d }));
  window.addEventListener("k2-keyboard-rec", onRec);
  window.addEventListener("k2-keyboard-will", onWill);
  window.addEventListener("touchmove", onTouch, { passive: true });
  window.addEventListener("touchend", onLift, { passive: true });
  void syncNative(true);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  setKeyboardDragObserver(null);
  window.removeEventListener("k2-keyboard-rec", onRec);
  window.removeEventListener("k2-keyboard-will", onWill);
  window.removeEventListener("touchmove", onTouch);
  window.removeEventListener("touchend", onLift);
  if (session) finish();
  preRoll = [];
  void syncNative(false);
}

/** App start: install if the pref is on; the dev-console switch. */
export function initKbDragRecorder(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __k2KbRecorder?: unknown }).__k2KbRecorder = {
    on: () => setRecorderOn(true),
    off: () => setRecorderOn(false),
    drags: () => recordedDrags().map((d) => d.score),
    dump: () => JSON.stringify(recordedDrags()[0]?.trace ?? null),
    clear: () => clearRecordedDrags(),
  };
  if (on) install();
}

/** Tests only. */
export function __resetKbRecorderForTests(): void {
  uninstall();
  on = false;
  drags = [];
  session = null;
  preRoll = [];
  subs.clear();
}
