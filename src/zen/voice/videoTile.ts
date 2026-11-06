import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, type RefObject } from "react";
import { create } from "zustand";
import { isIosWebView } from "../../lib/nativePicker";

// The call screen's video: the page draws a placeholder tile and Swift puts
// K2PiP's display layer over it (`callOp pipFrame`), the same layer PiP plays
// from. The layer sits above the webview and lets every touch through, so
// the tile's own tap (Picture in Picture) still lands here. It goes back
// under the webview whenever the tile isn't on screen: the overlay closed, a
// route change, the call's video gone, the recording sheet over it.

const PLUGIN = "k2-push";

/** Where the layer goes, in webview points (`visible: false`: hidden spot). */
export type TileFrame =
  | { visible: false }
  | {
      visible: true;
      x: number;
      y: number;
      w: number;
      h: number;
      radius: number;
      /** Get there on its own from where it is now (the mini tile's snap). */
      animate?: TileAnimation;
    };

/** How the layer moves to a frame (seconds, points/s): a Core Animation
 *  spring with these constants carrying the velocity in, or, with no
 *  `stiffness`, an ease-out (`miniSnap`). `startedAt` (wall clock, ms):
 *  when the page started the same motion, so Swift starts it when the
 *  page's tile shows it starting (`animateTo` sets it). */
export type TileAnimation = { startedAt?: number } & (
  | {
      duration: number;
      mass: number;
      stiffness: number;
      damping: number;
      velocityX: number;
      velocityY: number;
    }
  | { duration: number }
);

export const HIDDEN: TileFrame = { visible: false };

type Rect = { left: number; top: number; width: number; height: number };

/** The visual viewport (the keyboard and pinch move it off the layout one). */
export type Viewport = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  scale: number;
};

const half = (v: number) => Math.round(v * 2) / 2;

/** The layer's frame for a tile at `rect` (getBoundingClientRect: layout
 *  viewport px), inside its `border`. Hidden when it has no size or is off
 *  screen. */
export function tileFrame(rect: Rect, view: Viewport, radius: number, border = 0): TileFrame {
  const s = view.scale > 0 ? view.scale : 1;
  const x = (rect.left - view.offsetLeft + border) * s;
  const y = (rect.top - view.offsetTop + border) * s;
  const w = (rect.width - 2 * border) * s;
  const h = (rect.height - 2 * border) * s;
  if (!(w > 0 && h > 0)) return HIDDEN;
  if (x + w <= 0 || y + h <= 0 || x >= view.width * s || y >= view.height * s) return HIDDEN;
  return {
    visible: true,
    x: half(x),
    y: half(y),
    w: half(w),
    h: half(h),
    radius: half(Math.max(0, radius - border) * s),
  };
}

/** Same place (how it gets there aside). */
export function sameFrame(a: TileFrame | null, b: TileFrame): boolean {
  if (!a || a.visible !== b.visible) return false;
  if (!a.visible || !b.visible) return true;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.radius === b.radius;
}

function currentViewport(): Viewport {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv)
    return {
      width: vv.width,
      height: vv.height,
      offsetLeft: vv.offsetLeft,
      offsetTop: vv.offsetTop,
      scale: vv.scale,
    };
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
  };
}

function nativeSend(f: TileFrame): void {
  if (!isIosWebView()) return;
  void invoke(`plugin:${PLUGIN}|call_op`, { op: "pipFrame", ...f }).catch(() => {});
}

let send: (f: TileFrame) => void = nativeSend;
let last: TileFrame | null = null;

/** The frame to Swift, unless it's the one it already has. */
export function placeTile(f: TileFrame): void {
  if (sameFrame(last, f)) return;
  last = f;
  send(f);
}

// ── Who holds the layer ──────────────────────────────────────────────
// Several places can show the one layer (the call screen's tile, the mini
// tile elsewhere in the app). The last to claim it holds it; a release by
// one that no longer holds it changes nothing, so a tile going away just
// after another took the layer never hides it.

let holder = 0;
let nextHolder = 1;

/** Take the layer: an id for `placeLayerFor` / `releaseLayer`. */
export function claimLayer(): number {
  holder = nextHolder++;
  return holder;
}

/** Place the layer, if `id` still holds it. */
export function placeLayerFor(id: number, f: TileFrame): void {
  if (id === holder) placeTile(f);
}

/** Give the layer back: under the page, if `id` still held it. */
export function releaseLayer(id: number): void {
  if (id !== holder) return;
  holder = 0;
  placeTile(HIDDEN);
}

/** The layer's frame for a tile's bounds (`getBoundingClientRect()`). */
export function frameAt(rect: Rect, radius: number, border = 0): TileFrame {
  return tileFrame(rect, currentViewport(), radius, border);
}

// ── PiP's status (K2PiP's `pip` events) ─────────────────────────────────

type PipStatus = {
  /** The layer shows a frame (`pip_first_frame`, until `pip_cleared` or
   *  `pip_stalled`). */
  frame: boolean;
  /** Picture in Picture is up: the inline layer is empty meanwhile. */
  active: boolean;
};

export const usePipStatus = create<PipStatus>(() => ({
  frame: false,
  active: false,
}));

export function onPipEvent(e: { event?: unknown }): void {
  switch (e?.event) {
    case "pip_first_frame":
      usePipStatus.setState({ frame: true });
      return;
    case "pip_cleared":
    case "pip_stalled":
      // The image went, or no new frame for a while (a muted or paused
      // camera, a lost stream): the tile goes back to the person.
      usePipStatus.setState({ frame: false });
      return;
    case "pip_started":
      usePipStatus.setState({ active: true });
      return;
    case "pip_stopped":
    case "pip_failed":
      usePipStatus.setState({ active: false });
      return;
  }
}

let following = false;

/** Follow K2PiP's events from now on, starting from its state. */
export function followPip(): void {
  if (following || !isIosWebView()) return;
  following = true;
  void addPluginListener(PLUGIN, "pip", onPipEvent).catch(() => {
    following = false;
  });
  void invoke<Record<string, unknown>>(`plugin:${PLUGIN}|call_op`, {
    op: "pip",
  }).then(
    (r) =>
      usePipStatus.setState({
        frame: r?.frame === true,
        active: r?.active === true,
      }),
    () => {}
  );
}

function nativeHaptic(prepare: boolean): void {
  if (!isIosWebView()) return;
  void invoke(`plugin:${PLUGIN}|call_op`, prepare ? { op: "haptic", state: "prepare" } : { op: "haptic" }).catch(
    () => {}
  );
}

let haptic: (prepare: boolean) => void = nativeHaptic;

/** A light tap (UIImpactFeedbackGenerator .light): the mini tile landing in
 *  its corner. `prepare` warms the engine up just before. */
export function tileHaptic(prepare = false): void {
  haptic(prepare);
}

/** The tile's tap: Picture in Picture on, or back off. */
export function togglePip(): void {
  if (!isIosWebView()) return;
  const on = !usePipStatus.getState().active;
  void invoke(`plugin:${PLUGIN}|call_op`, { op: "pip", on }).catch(() => {});
}

// ── The tile ────────────────────────────────────────────────────────────

/** What a tile that moves itself (the mini tile) does with the layer. */
export type TileHandle = {
  /** Measure on the next frame (a move no resize sees: a drag). */
  schedule(): void;
  /** Measure now: inside a frame the page just moved the tile in. */
  placeNow(): void;
  /** The layer goes to the tile's spot at `rect` on its own (`animate`),
   *  started now: the page starts its own motion at the same moment. The
   *  page's own measurements wait until it's done, or the next `placeNow`. */
  animateTo(rect: Rect, animate: TileAnimation): void;
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** The wall clock in ms, at `now()`'s resolution (Swift reads the same clock). */
const wallClock = () =>
  typeof performance !== "undefined" && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now();

/** Keeps the layer on `ref`'s element while `show`, re-measured (once a
 *  frame at most) on its resize, any scroll, a window or keyboard change,
 *  and the return to the app. Hidden when `show` goes false or it unmounts.
 *  Going to the background leaves it in place: PiP's start and restore
 *  animate from the layer, and the page is measured again on return. */
export function useVideoTile(
  ref: RefObject<HTMLElement | null>,
  show: boolean,
  radius: number,
  border = 0,
  /** Measure again when this changes (a move no resize sees: a drag). */
  remeasure?: unknown
): TileHandle {
  const scheduleRef = useRef<(() => void) | null>(null);
  const live = useRef<Omit<TileHandle, "schedule"> | null>(null);
  const handle = useRef<TileHandle>({
    schedule: () => scheduleRef.current?.(),
    placeNow: () => live.current?.placeNow(),
    animateTo: (rect, animate) => live.current?.animateTo(rect, animate),
  });
  useEffect(() => {
    const el = ref.current;
    if (!show || !el) return;
    const id = claimLayer();
    let raf = 0;
    // While the layer animates on its own, page frames would cut it short.
    let busyUntil = 0;
    let busyTimer: ReturnType<typeof setTimeout> | null = null;
    const measure = (force = false) => {
      raf = 0;
      if (document.visibilityState === "hidden") return;
      const t = now();
      if (!force && t < busyUntil) {
        busyTimer ??= setTimeout(() => {
          busyTimer = null;
          schedule();
        }, busyUntil - t);
        return;
      }
      busyUntil = 0;
      placeLayerFor(id, tileFrame(el.getBoundingClientRect(), currentViewport(), radius, border));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => measure());
    };
    scheduleRef.current = schedule;
    live.current = {
      placeNow: () => {
        if (raf) cancelAnimationFrame(raf);
        measure(true);
      },
      animateTo: (rect, animate) => {
        const view = currentViewport();
        const f = tileFrame(rect, view, radius, border);
        if (!f.visible) return placeLayerFor(id, f);
        const s = view.scale > 0 ? view.scale : 1;
        busyUntil = now() + animate.duration * 1000 + 50;
        const startedAt = Math.round(wallClock() * 10) / 10;
        placeLayerFor(id, {
          ...f,
          animate:
            "stiffness" in animate
              ? { ...animate, velocityX: animate.velocityX * s, velocityY: animate.velocityY * s, startedAt }
              : { ...animate, startedAt },
        });
      },
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    if (el.parentElement) ro?.observe(el.parentElement);
    const vv = window.visualViewport;
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    document.addEventListener("visibilitychange", schedule);
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      scheduleRef.current = null;
      live.current = null;
      if (raf) cancelAnimationFrame(raf);
      if (busyTimer) clearTimeout(busyTimer);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("visibilitychange", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      releaseLayer(id);
    };
  }, [ref, show, radius, border]);
  useEffect(() => {
    scheduleRef.current?.();
  }, [remeasure]);
  return handle.current;
}

export function __setTileSenderForTests(next: ((f: TileFrame) => void) | null): void {
  send = next ?? nativeSend;
  last = null;
  holder = 0;
}

export function __setHapticForTests(next: ((prepare: boolean) => void) | null): void {
  haptic = next ?? nativeHaptic;
}

export function __resetPipForTests(): void {
  following = false;
  usePipStatus.setState({ frame: false, active: false });
}
