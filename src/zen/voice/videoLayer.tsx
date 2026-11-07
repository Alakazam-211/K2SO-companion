import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { VideoHandle } from "@sew/voice";
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
  type TileHandle,
} from "./videoTile";
import { useVoiceCall } from "./voiceCall";

// Where the call's one native video layer (K2PiP's AVSampleBufferDisplayLayer,
// fed by Rust's active-speaker sink) shows, all in one place:
//   - in the call screen, inside Sew's kit's CallView: the shown person's
//     tile hosts it (`renderTile` draws `LayerSlot`, `onTileRect` places the
//     layer: `useLayerPlacement`);
//   - in the call screen before the kit knows whose picture it is (or while
//     the kit loads): `VideoTile`, placing itself;
//   - anywhere else in the app: the floating call card (callTile.tsx), a
//     small draggable card in a corner, the picture on top of its Mute /
//     Deafen / Camera / Hang up strip. iOS starts PiP on its own only from a
//     layer that's on screen, so during a video call the layer always is.
// The layer lets touches through: these webview elements take the taps.
//
// Only while the picture is really live (the call has video and the layer
// shows a frame since its last flush, or plays in PiP): before the first
// frame, after a stall (K2PiP's `pip_stalled`: a muted or paused camera, a
// lost stream) or once the video ends, no video tile and no picture on the
// floating card; the kit's avatar tile stands for the person instead. Your own camera is never on
// this layer (the sink never shows you): `SelfView` draws it in the page.
// With no live picture the card shows your camera (`SelfView`) while it's on,
// else it folds down to the plain controls pill, in the same corner, on the
// same motion (`useCornerDrag`).

export const TILE_RADIUS = 12;
const TILE_BORDER = 1;

/** The call's picture plays now: video, and a frame on the layer (or PiP). */
export function useLiveVideo(): boolean {
  useEffect(() => followPip(), []);
  const video = useVoiceCall((s) => s.phase !== "idle" && s.video);
  const shows = usePipStatus((s) => s.frame || s.active);
  return video && shows;
}

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

// ── The floating tile's motion ──────────────────────────────────────

export type { Corner };
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

/** The last corner set, for when storage is unavailable: the floating
 *  tile keeps it for the session. */
let sessionCorner: Corner | null = null;

/** The floating tile's corner (with or without its picture). */
export function readCorner(): Corner {
  try {
    const v = localStorage.getItem(MINI_CORNER_KEY);
    return CORNERS.includes(v as Corner) ? (v as Corner) : "top-right";
  } catch {
    return sessionCorner ?? "top-right";
  }
}

export function __resetCornerForTests(): void {
  sessionCorner = null;
}

function writeCorner(c: Corner): void {
  sessionCorner = c;
  try {
    localStorage.setItem(MINI_CORNER_KEY, c);
  } catch {
    // storage unavailable: this session only
  }
}

type Rect = { left: number; top: number; width: number; height: number };

/** Where each corner puts the tile: clear of the edges, header and composer. */
export function anchorStyle(corner: Corner): CSSProperties {
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

/** Each corner's spot for the tile (unmoved, unscaled), measured, and for
 *  `part` (an element inside it: the card's picture) its spot there too. */
function measureHomes(
  el: HTMLElement,
  corner: Corner,
  part: HTMLElement | null
): { homes: Record<Corner, Rect>; parts: Record<Corner, Rect> } {
  const transform = el.style.transform;
  el.style.transform = "";
  const homes = {} as Record<Corner, Rect>;
  for (const c of CORNERS) {
    applyAnchor(el, c);
    const r = el.getBoundingClientRect();
    homes[c] = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  applyAnchor(el, corner);
  let parts = homes;
  if (part && el.contains(part)) {
    // Where the part sits in the tile: the same in every corner.
    const t = homes[corner];
    const p = part.getBoundingClientRect();
    parts = {} as Record<Corner, Rect>;
    for (const c of CORNERS)
      parts[c] = { left: homes[c].left + p.left - t.left, top: homes[c].top + p.top - t.top, width: p.width, height: p.height };
  }
  el.style.transform = transform;
  return { homes, parts };
}

const centre = (r: Rect): Vec => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const round = (v: number) => Math.round(v * 100) / 100;
const atRest = (p: Pose) => p.x === 0 && p.y === 0 && p.s === 1;

function poseTransform(p: Pose): string {
  if (atRest(p)) return "";
  const scale = p.s === 1 ? "" : ` scale(${Math.round(p.s * 10000) / 10000})`;
  return `translate(${round(p.x)}px, ${round(p.y)}px)${scale}`;
}

export function reduceMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const now = () => performance.now();

type Press = { id: number; x: number; y: number; from: Pose; moved: boolean; samples: Sample[] };

export const FLOAT_SHADOW = "0 8px 24px rgba(0, 0, 0, 0.45)";
export const FLOAT_HELD_SHADOW = "0 16px 36px rgba(0, 0, 0, 0.55)";

/** What moves with the floating tile besides the page's element: the native
 *  video layer over the card's picture (none without a live picture). */
export type Follower = Pick<TileHandle, "placeNow" | "schedule" | "animateTo">;

type CornerDragOptions = {
  follower?: Follower;
  /** The element the follower sits on, inside the tile (the card's
   *  picture): the snap sends the follower that part's spot. The whole
   *  tile when absent. */
  followerPart?: RefObject<HTMLElement | null>;
  /** A press that never became a drag, let go on `target`. */
  onTap(target: EventTarget | null): void;
  /** Take the finger only once it drags: a tap on a button inside stays the
   *  button's (the call card). Else it's taken at once. */
  captureOnDrag?: boolean;
};

export type CornerDrag = {
  corner: Corner;
  /** Held (dragged) now: lifted, the deeper shadow. */
  held: boolean;
  /** For the element: the finger, and no click after a drag. */
  handlers: {
    onPointerDown(e: ReactPointerEvent): void;
    onPointerMove(e: ReactPointerEvent): void;
    onPointerUp(e: ReactPointerEvent): void;
    onPointerCancel(e: ReactPointerEvent): void;
    onClickCapture(e: ReactMouseEvent): void;
  };
};

/** The floating tile's motion (the call card, with or without its picture):
 *  drag past `TAP_SLOP` (lifted), let go to the corner it would coast to on
 *  a spring (Reduce Motion: a short ease, no lift), a light tap as it lands,
 *  caught mid-flight it stops under the finger. One saved corner. */
export function useCornerDrag(ref: RefObject<HTMLElement | null>, opts: CornerDragOptions): CornerDrag {
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [held, setHeld] = useState(false);
  /** Where it's drawn now (the page moves it itself, never through React). */
  const pose = useRef<Pose>(REST);
  const raf = useRef(0);
  const press = useRef<Press | null>(null);
  /** A drag just ended: the click it makes is not a tap. */
  const dragged = useRef(false);
  const o = useRef(opts);
  o.current = opts;

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
      o.current.follower?.placeNow();
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
    const follower = o.current.follower;
    const { homes, parts } = measureHomes(el, corner, o.current.followerPart?.current ?? null);
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
    follower?.placeNow();
    writeCorner(next);
    setCorner(next);
    setHeld(false);
    const plan = planSnap(from, velocity, reduceMotion());
    follower?.animateTo(parts[next], plan.animate);
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
        o.current.follower?.placeNow();
      }
    };
    raf.current = requestAnimationFrame(tick);
  };

  const capture = (el: Element, id: number) => {
    try {
      el.setPointerCapture?.(id);
    } catch {
      // a synthetic pointer
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (press.current) return;
    dragged.current = false;
    if (raf.current) {
      // Caught on its way: it stops under the finger, the layer with it.
      stop();
      o.current.follower?.placeNow();
    }
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: pose.current,
      moved: false,
      samples: [{ t: now(), x: e.clientX, y: e.clientY }],
    };
    if (!o.current.captureOnDrag) capture(e.currentTarget as Element, e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    if (!p.moved) {
      p.moved = true;
      if (o.current.captureOnDrag) capture(e.currentTarget as Element, e.pointerId);
      setHeld(true);
      lift();
    }
    p.samples.push({ t: now(), x: e.clientX, y: e.clientY });
    if (p.samples.length > 16) p.samples.shift();
    draw({ x: p.from.x + dx, y: p.from.y + dy, s: pose.current.s });
    o.current.follower?.schedule();
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.moved) {
      if (!atRest(pose.current)) snap({ x: 0, y: 0 });
      o.current.onTap(e.target);
      return;
    }
    dragged.current = true;
    p.samples.push({ t: now(), x: e.clientX, y: e.clientY });
    snap(releaseVelocity(p.samples));
  };
  const onPointerCancel = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.moved) dragged.current = true;
    if (p.moved || !atRest(pose.current)) snap({ x: 0, y: 0 });
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    // The click a drag ends in (WebKit can still send one): never a button's.
    if (!dragged.current) return;
    dragged.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { corner, held, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } };
}

/** A floating tile comes in with a short fade (none with Reduce Motion):
 *  the call area closing brings it up without a pop. */
export function useFadeIn(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion() || typeof el.animate !== "function") return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }, [ref]);
}

// ── Your camera ──────────────────────────────────────────────────────

/** Your own tile's video while your camera is on: the kit's `local:camera`
 *  sink drawn in the page (never the native layer, never PiP), and "Camera
 *  paused" while the app was in the
 *  background (Sew pauses the camera there; it turns off after 5 minutes).
 *  `untilFrame`: shown over it until its first frame plays (the floating
 *  card's "Camera on", never a plain black box). */
export function SelfView({
  handle,
  paused,
  radius = TILE_RADIUS,
  untilFrame,
}: {
  handle: VideoHandle;
  paused: boolean;
  radius?: CSSProperties["borderRadius"];
  untilFrame?: ReactNode;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const frame = (e: { currentTarget: HTMLVideoElement }) => {
    if (e.currentTarget.videoWidth > 0 || e.currentTarget.readyState >= 2) setPlaying(true);
  };
  // Attach once per track, as the kit's own tile does: a new handle object
  // for the same track must not restart the stream.
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = latest.current;
    setPlaying(false);
    h.attach(el);
    return () => h.detach(el);
  }, [handle.key]);
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ borderRadius: radius, background: "#000" }}
      data-testid="voice-self-view"
      data-paused={paused ? "yes" : "no"}
    >
      <video
        ref={ref}
        className="block"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // No mirror here: the kit's handle mirrors the front camera on
          // the element itself, frame by frame (Sew 0.8.2, mirrorSelfView
          // 'auto'), so a flip never shows a frame the wrong way round.
          opacity: paused ? 0.35 : 1,
        }}
        autoPlay
        playsInline
        muted
        aria-label="Your camera"
        data-testid="voice-self-video"
        onLoadedData={frame}
        onPlaying={frame}
        onResize={frame}
      />
      {paused ? <Line text="Camera paused" /> : !playing ? untilFrame : null}
    </div>
  );
}
