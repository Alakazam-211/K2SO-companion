import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { VideoHandle } from "@sew/voice";
import { createPortal } from "react-dom";
import { claimLayer, followPip, frameAt, placeLayerFor, releaseLayer, togglePip, usePipStatus, useVideoTile } from "./videoTile";
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
//
// Only while the picture is really live (the call has video and the layer
// shows a frame since its last flush, or plays in PiP): before the first
// frame, after a stall (K2PiP's `pip_stalled`: a muted or paused camera, a
// lost stream) or once the video ends, no tile and no mini tile; the kit's
// avatar tile stands for the person instead. Your own camera is never on
// this layer (the sink never shows you): `SelfView` draws it in the page.

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

// ── The mini tile ────────────────────────────────────────────────────

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const CORNERS: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
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

/** The corner nearest to where the tile was let go (its centre). */
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

/** The mini tile shows while the call's picture is live and its screen is
 *  closed: never an empty or black tile. */
export function useMiniTileShown(callViewOpen: boolean): boolean {
  const live = useLiveVideo();
  const inCall = useVoiceCall((s) => s.phase !== "idle" && !!s.room);
  return inCall && live && !callViewOpen;
}

/** FaceTime's small video, over the app while the call screen is closed:
 *  drag it to any corner, tap it for the call. */
export function MiniVideoTile({ callViewOpen, onOpen }: { callViewOpen: boolean; onOpen: () => void }) {
  const shown = useMiniTileShown(callViewOpen);
  if (!shown || typeof document === "undefined") return null;
  return createPortal(<Mini onOpen={onOpen} />, document.body);
}

function Mini({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const press = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pip = usePipStatus((s) => s.active);
  useEffect(() => followPip(), []);
  // Resize, scroll, rotation and the return to the app re-place it; so does
  // every move of a drag and the snap.
  useVideoTile(ref, true, MINI_RADIUS, 0, `${corner}:${drag?.dx ?? ""}:${drag?.dy ?? ""}`);

  const down = (e: ReactPointerEvent) => {
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
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
    p.moved = true;
    setDrag({ dx, dy });
  };
  const up = (e: ReactPointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved) {
      setDrag(null);
      onOpen();
      return;
    }
    const r = ref.current?.getBoundingClientRect();
    const next = r
      ? nearestCorner(r.left + r.width / 2, r.top + r.height / 2, window.innerWidth, window.innerHeight)
      : corner;
    writeCorner(next);
    setCorner(next);
    setDrag(null);
  };
  const cancel = () => {
    press.current = null;
    setDrag(null);
  };

  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  return (
    <button
      ref={ref}
      type="button"
      className="fixed block overflow-hidden"
      style={{
        [v]: v === "top" ? TOP_CLEAR : BOTTOM_CLEAR,
        [h]: `calc(env(safe-area-inset-${h}, 0px) + ${EDGE}px)`,
        width: MINI_W,
        height: MINI_H,
        borderRadius: MINI_RADIUS,
        background: "#000",
        border: "1px solid var(--tile-edge)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
        padding: 0,
        zIndex: 40,
        touchAction: "none",
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
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

// ── Your camera ──────────────────────────────────────────────────────

/** Your own tile's video while your camera is on: the kit's `local:camera`
 *  sink drawn in the page (never the native layer, never PiP), mirrored for
 *  the front camera, and "Camera paused" while the app was in the
 *  background (Sew pauses the camera there; it turns off after 5 minutes). */
export function SelfView({ handle, mirrored, paused }: { handle: VideoHandle; mirrored: boolean; paused: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Attach once per track, as the kit's own tile does: a new handle object
  // for the same track must not restart the stream.
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = latest.current;
    h.attach(el);
    return () => h.detach(el);
  }, [handle.key]);
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ borderRadius: TILE_RADIUS, background: "#000" }}
      data-testid="voice-self-view"
      data-mirrored={mirrored ? "yes" : "no"}
      data-paused={paused ? "yes" : "no"}
    >
      <video
        ref={ref}
        className="block"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: mirrored ? "scaleX(-1)" : undefined,
          opacity: paused ? 0.35 : 1,
        }}
        autoPlay
        playsInline
        muted
        aria-label="Your camera"
        data-testid="voice-self-video"
      />
      {paused ? <Line text="Camera paused" /> : null}
    </div>
  );
}
