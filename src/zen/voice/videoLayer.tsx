import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  CORNERS,
  easeOut,
  LIFT_DURATION,
  LIFT_SCALE,
  pickCorner,
  planSnap,
  releaseVelocity,
  REST,
  type Corner,
  type Pose,
  type Sample,
  type Vec,
} from "./miniSnap";
import {
  claimLayer,
  followPip,
  frameAt,
  placeLayerFor,
  releaseLayer,
  tileHaptic,
  togglePip,
  usePipStatus,
  useVideoTile,
} from "./videoTile";
import { useVoiceCall } from "./voiceCall";

// Where the call's one native video layer (K2PiP's AVSampleBufferDisplayLayer,
// fed by Rust's active-speaker sink) shows, all in one place:
//   - in the call screen, inside Sew's kit's CallView: the shown person's
//     tile hosts it (`renderTile` draws `LayerSlot`, `onTileRect` places the
//     layer: `useLayerPlacement`);
//   - in the call screen before the kit knows whose picture it is (or while
//     the kit loads): `VideoTile`, placing itself;
//   - anywhere else in the app: `MiniVideoTile`, a small draggable tile in a
//     corner. iOS starts PiP on its own only from a layer that's on screen,
//     so during a video call the layer always is.
// The layer lets touches through: these webview elements take the taps.

export const TILE_RADIUS = 12;
const TILE_BORDER = 1;

function useLayerLine(): string | null {
  const frame = usePipStatus((s) => s.frame);
  const pip = usePipStatus((s) => s.active);
  return pip ? "Playing in Picture in Picture" : frame ? null : "Video starting…";
}

function Line({ text, small = false }: { text: string | null; small?: boolean }) {
  if (!text) return null;
  return (
    <span
      className={`absolute inset-0 flex items-center justify-center text-center ${small ? "text-[11px]" : "text-[13px]"}`}
      style={{ color: "#8e8e93", padding: 4 }}
      data-testid="voice-video-line"
    >
      {text}
    </span>
  );
}

/** The call's video as its own tile, placing the layer itself. */
export function VideoTile({ covered }: { covered: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const line = useLayerLine();
  const pip = usePipStatus((s) => s.active);
  useEffect(() => followPip(), []);
  useVideoTile(ref, !covered, TILE_RADIUS, TILE_BORDER);
  return (
    <button
      ref={ref}
      type="button"
      className="relative block overflow-hidden"
      style={{
        width: "min(100%, calc(40vh * 16 / 9))",
        aspectRatio: "16 / 9",
        margin: "0 auto 10px",
        borderRadius: TILE_RADIUS,
        border: `${TILE_BORDER}px solid var(--tile-edge)`,
        background: "#000",
      }}
      onClick={togglePip}
      aria-label={pip ? "Video in Picture in Picture. Tap to bring it back." : "Video. Tap for Picture in Picture."}
      data-testid="voice-video-tile"
    >
      <Line text={line} />
    </button>
  );
}

/** What a kit tile's video rect holds when the layer is drawn over it
 *  (`renderTile`): the status line, and the tap for PiP. The kit places
 *  nothing over it; `useLayerPlacement` puts the layer on it. */
export function LayerSlot() {
  const line = useLayerLine();
  const pip = usePipStatus((s) => s.active);
  useEffect(() => followPip(), []);
  return (
    <button
      type="button"
      className="absolute inset-0 block overflow-hidden"
      style={{ width: "100%", height: "100%", borderRadius: TILE_RADIUS, background: "#000", border: 0, padding: 0 }}
      onClick={togglePip}
      aria-label={pip ? "Video in Picture in Picture. Tap to bring it back." : "Video. Tap for Picture in Picture."}
      data-testid="voice-video-tile"
    >
      <Line text={line} />
    </button>
  );
}

/** The kit's `onTileRect` for the hosted tile: the layer follows it, under
 *  the page while something covers it (the recording notice). In the
 *  background it stays put: PiP's start and restore animate from it. */
export function useLayerPlacement(covered: boolean): (rect: DOMRectReadOnly | null) => void {
  const last = useRef<DOMRectReadOnly | null>(null);
  const held = useRef<number | null>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const apply = useCallback(() => {
    const rect = coveredRef.current ? null : last.current;
    if (rect) {
      held.current ??= claimLayer();
      placeLayerFor(held.current, frameAt(rect, TILE_RADIUS));
    } else if (held.current !== null) {
      releaseLayer(held.current);
      held.current = null;
    }
  }, []);
  const place = useCallback(
    (rect: DOMRectReadOnly | null) => {
      last.current = rect;
      if (rect && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      apply();
    },
    [apply]
  );
  useEffect(apply, [covered, apply]);
  useEffect(() => {
    // Back in the app: where the tile is now.
    const back = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      if (held.current !== null) releaseLayer(held.current);
      held.current = null;
    };
  }, [apply]);
  return place;
}

// ── The mini tile ────────────────────────────────────────────────────

export type { Corner };
export const MINI_W = 120;
export const MINI_H = 68;
const MINI_RADIUS = 10;
/** Clear of the screen's edge, the header and the composer / search bar. */
const EDGE = 12;
const TOP_CLEAR = "calc(env(safe-area-inset-top, 0px) + 64px)";
const BOTTOM_CLEAR = "calc(var(--safe-bottom, 0px) + 84px)";
/** A press that moves less than this is a tap. */
const TAP_SLOP = 8;
export const MINI_CORNER_KEY = "k2.voice.miniCorner.v1";

/** The corner nearest to where the tile was let go (its centre), with no
 *  velocity. The tile itself uses `pickCorner`. */
export function nearestCorner(cx: number, cy: number, width: number, height: number): Corner {
  return `${cy < height / 2 ? "top" : "bottom"}-${cx < width / 2 ? "left" : "right"}` as Corner;
}

export function readCorner(): Corner {
  try {
    const v = localStorage.getItem(MINI_CORNER_KEY);
    return CORNERS.includes(v as Corner) ? (v as Corner) : "top-right";
  } catch {
    return "top-right";
  }
}

function writeCorner(c: Corner): void {
  try {
    localStorage.setItem(MINI_CORNER_KEY, c);
  } catch {
    // storage unavailable: this session only
  }
}

/** The mini tile shows while the call has video and its screen is closed. */
export function useMiniTileShown(callViewOpen: boolean): boolean {
  return useVoiceCall((s) => s.phase !== "idle" && !!s.room && s.video && !callViewOpen);
}

/** FaceTime's small video, over the app while the call screen is closed:
 *  drag it to any corner, tap it for the call. */
export function MiniVideoTile({ callViewOpen, onOpen }: { callViewOpen: boolean; onOpen: () => void }) {
  const shown = useMiniTileShown(callViewOpen);
  if (!shown || typeof document === "undefined") return null;
  return createPortal(<Mini onOpen={onOpen} />, document.body);
}

type Rect = { left: number; top: number; width: number; height: number };

/** Where each corner puts the tile: clear of the edges, header and composer. */
function anchorStyle(corner: Corner): CSSProperties {
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  return {
    [v]: v === "top" ? TOP_CLEAR : BOTTOM_CLEAR,
    [h]: `calc(env(safe-area-inset-${h}, 0px) + ${EDGE}px)`,
  };
}

function applyAnchor(el: HTMLElement, corner: Corner): void {
  const a = anchorStyle(corner) as Record<string, string | undefined>;
  for (const side of ["top", "bottom", "left", "right"] as const) el.style[side] = a[side] ?? "";
  el.dataset.corner = corner;
}

/** Each corner's spot for the tile (unmoved, unscaled), measured. */
function measureHomes(el: HTMLElement, corner: Corner): Record<Corner, Rect> {
  const transform = el.style.transform;
  el.style.transform = "";
  const homes = {} as Record<Corner, Rect>;
  for (const c of CORNERS) {
    applyAnchor(el, c);
    const r = el.getBoundingClientRect();
    homes[c] = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  applyAnchor(el, corner);
  el.style.transform = transform;
  return homes;
}

const centre = (r: Rect): Vec => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const round = (v: number) => Math.round(v * 100) / 100;
const atRest = (p: Pose) => p.x === 0 && p.y === 0 && p.s === 1;

function poseTransform(p: Pose): string {
  if (atRest(p)) return "";
  const scale = p.s === 1 ? "" : ` scale(${Math.round(p.s * 10000) / 10000})`;
  return `translate(${round(p.x)}px, ${round(p.y)}px)${scale}`;
}

function reduceMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const now = () => performance.now();

type Press = { id: number; x: number; y: number; from: Pose; moved: boolean; samples: Sample[] };

const SHADOW = "0 8px 24px rgba(0, 0, 0, 0.45)";
const HELD_SHADOW = "0 16px 36px rgba(0, 0, 0, 0.55)";

function Mini({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [held, setHeld] = useState(false);
  /** Where it's drawn now (the page moves it itself, never through React). */
  const pose = useRef<Pose>(REST);
  const raf = useRef(0);
  const press = useRef<Press | null>(null);
  const pip = usePipStatus((s) => s.active);
  useEffect(() => followPip(), []);
  // Resize, scroll, rotation and the return to the app re-place the layer;
  // the drag and the snap below move it too.
  const tile = useVideoTile(ref, true, MINI_RADIUS, 0);

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  };
  useEffect(() => stop, []);

  const draw = (p: Pose) => {
    pose.current = p;
    if (ref.current) ref.current.style.transform = poseTransform(p);
  };

  /** Picked up: a little bigger (not with Reduce Motion), the layer too. */
  const lift = () => {
    if (reduceMotion()) return;
    const start = now();
    const s0 = pose.current.s;
    const tick = () => {
      const u = Math.min(1, (now() - start) / (LIFT_DURATION * 1000));
      draw({ ...pose.current, s: s0 + (LIFT_SCALE - s0) * easeOut(u) });
      tile.placeNow();
      raf.current = u < 1 ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  };

  /** Let go at `velocity`: to the corner it would coast to, on a spring
   *  (Swift runs the same one on the layer), a light tap as it lands. */
  const snap = (velocity: Vec) => {
    const el = ref.current;
    if (!el) return;
    stop();
    const homes = measureHomes(el, corner);
    const here = centre(homes[corner]);
    const at = { x: here.x + pose.current.x, y: here.y + pose.current.y };
    const next = pickCorner(at, velocity, {
      "top-left": centre(homes["top-left"]),
      "top-right": centre(homes["top-right"]),
      "bottom-left": centre(homes["bottom-left"]),
      "bottom-right": centre(homes["bottom-right"]),
    });
    const there = centre(homes[next]);
    // Same place on screen, now measured from the new corner.
    const from = { x: at.x - there.x, y: at.y - there.y, s: pose.current.s };
    applyAnchor(el, next);
    draw(from);
    tile.placeNow();
    writeCorner(next);
    setCorner(next);
    setHeld(false);
    const plan = planSnap(from, velocity, reduceMotion());
    tile.animateTo(homes[next], plan.animate);
    tileHaptic(true);
    const start = now();
    let landed = false;
    const tick = () => {
      const t = (now() - start) / 1000;
      if (!landed && t >= plan.landAt) {
        landed = true;
        tileHaptic();
      }
      draw(plan.at(t));
      if (t < plan.duration) {
        raf.current = requestAnimationFrame(tick);
      } else {
        raf.current = 0;
        tile.placeNow();
      }
    };
    raf.current = requestAnimationFrame(tick);
  };

  const down = (e: ReactPointerEvent) => {
    if (press.current) return;
    if (raf.current) {
      // Caught on its way: it stops under the finger, the layer with it.
      stop();
      tile.placeNow();
    }
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: pose.current,
      moved: false,
      samples: [{ t: now(), x: e.clientX, y: e.clientY }],
    };
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // a synthetic pointer
    }
  };
  const move = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    if (!p.moved) {
      p.moved = true;
      setHeld(true);
      lift();
    }
    p.samples.push({ t: now(), x: e.clientX, y: e.clientY });
    if (p.samples.length > 16) p.samples.shift();
    draw({ x: p.from.x + dx, y: p.from.y + dy, s: pose.current.s });
    tile.schedule();
  };
  const up = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.moved) {
      if (!atRest(pose.current)) snap({ x: 0, y: 0 });
      onOpen();
      return;
    }
    p.samples.push({ t: now(), x: e.clientX, y: e.clientY });
    snap(releaseVelocity(p.samples));
  };
  const cancel = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.moved || !atRest(pose.current)) snap({ x: 0, y: 0 });
  };

  return (
    <button
      ref={ref}
      type="button"
      className="fixed block overflow-hidden"
      style={{
        ...anchorStyle(corner),
        width: MINI_W,
        height: MINI_H,
        borderRadius: MINI_RADIUS,
        background: "#000",
        border: "1px solid var(--tile-edge)",
        boxShadow: held ? HELD_SHADOW : SHADOW,
        transition: "box-shadow 0.18s ease-out",
        willChange: "transform",
        padding: 0,
        zIndex: 40,
        touchAction: "none",
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      aria-label="The call's video. Tap to open the call."
      data-testid="voice-mini-tile"
      data-corner={corner}
    >
      {pip ? <Line text="Picture in Picture" small /> : null}
    </button>
  );
}
