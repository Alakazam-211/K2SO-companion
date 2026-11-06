import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Headphones, HeadphoneOff, Lock, Mic, MicOff, Pause, PhoneOff, Video, VideoOff } from "lucide-react";
import { useCallDuration } from "./callDuration";
import { easeOut } from "./miniSnap";
import { useTileCamera, useTileCameraFeed } from "./tileCamera";
import {
  anchorStyle,
  FLOAT_HELD_SHADOW,
  FLOAT_SHADOW,
  reduceMotion,
  SelfView,
  useCornerDrag,
  useFadeIn,
  useLiveVideo,
} from "./videoLayer";
import { usePipStatus, useVideoTile } from "./videoTile";
import { useVoiceCall } from "./voiceCall";

// The floating call tile, over the app while a call is up and its area is
// closed (Rosson 2026-11-06): one draggable unit in a corner, on the shared
// motion (useCornerDrag: drag, velocity snap on the spring, catch, lift,
// haptic, Reduce Motion, one saved corner).
//   - The controls strip: Mute, Deafen, Camera (when the call can do video)
//     and Hang up. The buttons are the call bar's own actions through the
//     store (`setMuted`, `setDeafened`, `leave`) and the kit's camera path
//     (tileCamera.ts); the state the engine's (muted, deafened, a
//     moderator's mute or deafen, a lost SPEAK, the camera's `local_video`).
//     Camera on and off only: the switch and the screen share stay in the
//     call screen's bar.
//   - A picture on top of it, "attached" (Rosson: "attach it to the bottom
//     of the video tile"), as one rounded glass card: the picture's top
//     corners rounded, square where it meets the strip.
//       - someone's video plays: the native layer (K2PiP, the active
//         speaker's picture) on the picture's rect, following it through the
//         drag and the spring (`pipFrame` with that sub-rect, `corners:
//         "top"`). On screen, so PiP still starts on its own going home;
//       - else, your camera on: your self-view in the page (the kit's
//         `local:camera` sink, mirrored for the front camera; "Camera on"
//         until its first frame). Never the native layer, never PiP;
//       - else no picture: the card folds down to the plain pill.
//     Under the picture, a band (DURATION_BAND) with the call's time in its
//     bottom-left corner (Rosson 2026-11-06: "If the camera is on, show call
//     duration in the bottom left of the floating tile"). Swift brings the
//     native layer ABOVE the webview on the picture's rect (K2PiP.swift
//     `place`), so nothing the page draws can sit on someone's video: the
//     layer covers the picture only and the time sits in the band below
//     it. Your self-view is the page's own, so it fills the band too and
//     the time sits over your picture. Same spot and same card size either
//     way, so the switch between them stays in place. The pill: no time.
//     The picture opens and folds smoothly in place: in a bottom corner the
//     strip stays put and the picture grows above it; in a top corner the
//     card's top stays under the header and the strip moves down with it.
//     The corner's insets hold the whole card (anchorStyle: its top edge or
//     its bottom edge), so it never goes under the header or the composer.
// The finger is taken only once it drags, so a tap on a button is the
// button's; a tap anywhere else (the picture, the strip's edge) opens the call.

export const CALL_TILE_BUTTON = 40;
const GAP = 8;
const PAD = 8;
/** The strip's width for `buttons` buttons. */
export function callTileWidth(buttons: number): number {
  return CALL_TILE_BUTTON * buttons + GAP * (buttons - 1) + PAD * 2;
}
/** The pill: Mute, Deafen, Hang up. */
export const CALL_TILE_W = callTileWidth(3);
/** With the camera button. */
export const CALL_TILE_W_CAMERA = callTileWidth(4);
export const CALL_TILE_H = CALL_TILE_BUTTON + PAD * 2;
/** The card's edge (its border). */
export const CARD_EDGE = 1;
/** The picture's top corners (the pill's are half its height). */
export const CARD_TOP_RADIUS = 16;
/** The picture opens or folds over this long (ease-out). */
export const CARD_GROW = 0.24;

/** The band under the picture that carries the call's time, below the
 *  native layer's rect. */
export const DURATION_BAND = 22;

/** The picture's height in a card `width` wide: 16:9 inside its edge. */
export function cardVideoHeight(width: number): number {
  return Math.round(((width - 2 * CARD_EDGE) * 9) / 16);
}

/** The tile shows while a call is up and its area is closed. */
export function useCallTileShown(callViewOpen: boolean): boolean {
  const inCall = useVoiceCall((s) => s.phase !== "idle" && !!s.room);
  return inCall && !callViewOpen;
}

/** What the card's picture shows: someone's live video (the native layer),
 *  else your camera while it runs, else nothing (the plain pill). */
export type CardPicture = "remote" | "self" | null;

export function useCardPicture(): CardPicture {
  const live = useLiveVideo();
  const selfOn = useTileCamera((s) => s.selfOn);
  return live ? "remote" : selfOn ? "self" : null;
}

export function CallTile({ callViewOpen, onOpen }: { callViewOpen: boolean; onOpen: () => void }) {
  const shown = useCallTileShown(callViewOpen);
  if (!shown || typeof document === "undefined") return null;
  return createPortal(<Card onOpen={onOpen} />, document.body);
}

const GLASS_BG = "rgba(255, 255, 255, 0.1)";
const GLASS_EDGE = "rgba(255, 255, 255, 0.22)";
const SHEEN = "inset 0 1px 0 rgba(255, 255, 255, 0.28)";
/** Hang up keeps its red but gets the glass rim too (Rosson): light along
 *  the top edge, a little shade along the bottom. */
const DANGER_EDGE = "rgba(255, 255, 255, 0.28)";
const DANGER_SHEEN = "inset 0 1px 0 rgba(255, 255, 255, 0.38), inset 0 -1px 0 rgba(0, 0, 0, 0.22)";
const PILL_RADIUS = CALL_TILE_H / 2;
const MUTED_TEXT = "#8e8e93";

function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      className="absolute flex items-center justify-center"
      style={{ right: -2, bottom: -2, width: 16, height: 16, borderRadius: 8, background: "#1c1c1e", color: "#fff" }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

function TileButton({
  label,
  pressed,
  off,
  danger,
  locked,
  inactive,
  badge,
  onPress,
  testId,
  state,
  children,
}: {
  label: string;
  pressed?: boolean;
  /** Engaged (muted, deafened, the camera on): white, as the call bar's. */
  off?: boolean;
  danger?: boolean;
  /** Held by a moderator: shows it, does nothing (still drags the tile). */
  locked?: boolean;
  /** Can't be pressed now (the camera asking, or refused): dimmed, does nothing. */
  inactive?: boolean;
  /** A mark in its corner (the camera paused). */
  badge?: ReactNode;
  onPress: () => void;
  testId: string;
  state?: string;
  children: ReactNode;
}) {
  const dead = locked || inactive;
  return (
    <button
      type="button"
      className="relative flex items-center justify-center shrink-0"
      style={{
        width: CALL_TILE_BUTTON,
        height: CALL_TILE_BUTTON,
        borderRadius: CALL_TILE_BUTTON / 2,
        padding: 0,
        border: `0.5px solid ${danger ? DANGER_EDGE : off ? "#fff" : GLASS_EDGE}`,
        background: danger ? "#ff453a" : off ? "#fff" : GLASS_BG,
        boxShadow: danger ? DANGER_SHEEN : off ? "none" : SHEEN,
        color: danger || off ? "#000" : "#fff",
        opacity: dead ? 0.55 : 1,
      }}
      // Not `disabled`: WebKit sends a disabled button no pointer events, and
      // a drag may start on any part of the tile.
      aria-disabled={dead || undefined}
      aria-pressed={pressed}
      aria-label={label}
      onClick={() => {
        if (!dead) onPress();
      }}
      data-testid={testId}
      data-locked={locked ? "yes" : undefined}
      data-state={state}
    >
      {children}
      {locked ? (
        <Badge>
          <Lock size={9} strokeWidth={3} />
        </Badge>
      ) : badge ? (
        <Badge>{badge}</Badge>
      ) : null}
    </button>
  );
}

/** Mute, Deafen, Camera and Hang up: the strip under the picture. */
function Controls() {
  const muted = useVoiceCall((s) => s.muted);
  const deafened = useVoiceCall((s) => s.deafened);
  const muteLocked = useVoiceCall((s) => s.muteLocked);
  const deafLocked = useVoiceCall((s) => s.deafLocked);
  const camera = useTileCamera();
  const deaf = deafened || deafLocked;
  const micOff = muted || muteLocked || deaf;
  const call = useVoiceCall.getState;
  const camOn = camera.state === "on" || camera.state === "paused";
  return (
    <div className="flex items-center" style={{ flex: "1 1 0%", minHeight: 0, padding: PAD, gap: GAP }}>
      <TileButton
        label={muteLocked ? "Muted by a moderator" : micOff ? "Unmute" : "Mute"}
        pressed={micOff}
        off={micOff}
        locked={muteLocked}
        onPress={() => call().setMuted(!micOff)}
        testId="voice-call-tile-mute"
      >
        {micOff ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
      </TileButton>
      <TileButton
        label={deafLocked ? "Deafened by a moderator" : deaf ? "Undeafen" : "Deafen"}
        pressed={deaf}
        off={deaf}
        locked={deafLocked}
        onPress={() => call().setDeafened(!deaf)}
        testId="voice-call-tile-deafen"
      >
        {deaf ? <HeadphoneOff size={18} aria-hidden="true" /> : <Headphones size={18} aria-hidden="true" />}
      </TileButton>
      {camera.shown ? (
        <TileButton
          label={camera.label}
          pressed={camOn}
          off={camOn}
          inactive={!camera.enabled}
          badge={camera.state === "paused" ? <Pause size={8} strokeWidth={3} /> : undefined}
          onPress={camera.toggle}
          testId="voice-call-tile-camera"
          state={camera.state}
        >
          {camOn ? <Video size={18} aria-hidden="true" /> : <VideoOff size={18} aria-hidden="true" />}
        </TileButton>
      ) : null}
      <TileButton label="Hang up" danger onPress={() => void call().leave()} testId="voice-call-tile-leave">
        <PhoneOff size={18} aria-hidden="true" />
      </TileButton>
    </div>
  );
}

/** Your camera before its first frame (or with no self-view this webview
 *  can draw): a camera and a word, never a black box. */
function CameraNote({ paused }: { paused: boolean }) {
  return (
    <span
      className="absolute inset-0 flex flex-col items-center justify-center text-[11px]"
      style={{ color: MUTED_TEXT, background: "#1c1c1e", gap: 4 }}
      data-testid="voice-call-tile-camera-note"
    >
      <Video size={18} aria-hidden="true" />
      {paused ? "Camera paused" : "Camera on"}
    </span>
  );
}

/** Someone's video: the native layer sits over the picture; this shows
 *  only while PiP has it. */
function Remote() {
  const pip = usePipStatus((s) => s.active);
  return pip ? (
    <span
      className="absolute inset-0 flex items-center justify-center text-center text-[11px]"
      style={{ color: MUTED_TEXT, padding: 4 }}
      data-testid="voice-video-line"
    >
      Picture in Picture
    </span>
  ) : null;
}

/** Your self-view, drawn by the page over the picture and the band. */
function Self() {
  const self = useTileCamera((s) => s.self);
  const mirrored = useTileCamera((s) => s.mirrored);
  const paused = useTileCamera((s) => s.state === "paused");
  if (!self) return <CameraNote paused={paused} />;
  return <SelfView handle={self} mirrored={mirrored} paused={paused} radius={0} untilFrame={<CameraNote paused={false} />} />;
}

/** The call's time in the band's bottom-left corner: small tabular white
 *  on a dark chip, readable over any picture. Nothing until it connects. */
function Duration() {
  const time = useCallDuration();
  if (!time) return null;
  return (
    <span
      className="absolute text-[11px]"
      style={{
        left: PAD,
        bottom: (DURATION_BAND - 16) / 2,
        height: 16,
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: 8,
        background: "rgba(0, 0, 0, 0.5)",
        color: "#fff",
        // The counter alone in the monospace face; the card keeps the chosen font.
        fontFamily: '"MesloLGM Nerd Font Mono", ui-monospace, monospace',
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
      data-testid="voice-call-tile-duration"
    >
      {time}
    </span>
  );
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const now = () => performance.now();

function Card({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const roomName = useVoiceCall((s) => s.room?.roomName ?? "");
  useTileCameraFeed();
  const cameraShown = useTileCamera((s) => s.shown);
  const picture = useCardPicture();
  // The last picture, for its backdrop while it folds away.
  const lastPicture = useRef(picture);
  if (picture) lastPicture.current = picture;
  const backdrop = picture ?? lastPicture.current;
  const width = cameraShown ? CALL_TILE_W_CAMERA : CALL_TILE_W;
  const videoH = cardVideoHeight(width);
  // The native layer on the picture's rect while someone's video plays:
  // re-placed on resize, scroll, rotation and the return to the app, and by
  // the drag, the snap and the picture opening.
  const tile = useVideoTile(pictureRef, picture === "remote", CARD_TOP_RADIUS - CARD_EDGE, 0, undefined, "top");
  const { corner, held, handlers } = useCornerDrag(ref, {
    follower: tile,
    followerPart: pictureRef,
    captureOnDrag: true,
    // A button's tap is the button's; anywhere else opens the call.
    onTap: (target) => {
      const hit = target instanceof Element ? target.closest("button") : null;
      if (!hit || !ref.current?.contains(hit)) onOpen();
    },
  });
  useFadeIn(ref);

  // How open the picture is (0: the plain pill, 1: the card), drawn by the
  // page itself, never through React.
  const open = useRef(picture ? 1 : 0);
  const heightRef = useRef(videoH);
  heightRef.current = videoH;
  const tween = useRef(0);
  const draw = (k: number) => {
    open.current = k;
    const card = ref.current;
    const media = mediaRef.current;
    const pic = pictureRef.current;
    if (!card || !media || !pic) return;
    const h = heightRef.current * k;
    const band = DURATION_BAND * k;
    const r = PILL_RADIUS + (CARD_TOP_RADIUS - PILL_RADIUS) * k;
    card.style.height = px(CALL_TILE_H + h + band);
    card.style.borderRadius = `${px(r)} ${px(r)} ${PILL_RADIUS}px ${PILL_RADIUS}px`;
    media.style.height = px(h + band);
    media.style.opacity = k >= 1 ? "" : String(Math.round(k * 1000) / 1000);
    pic.style.height = px(h);
    const pr = Math.max(0, r - CARD_EDGE);
    media.style.borderRadius = `${px(pr)} ${px(pr)} 0px 0px`;
    pic.style.borderRadius = `${px(pr)} ${px(pr)} 0px 0px`;
    card.dataset.open = k >= 1 ? "yes" : k <= 0 ? "no" : "moving";
  };
  // A new width (the camera button came or went): the same openness, now.
  useLayoutEffect(() => draw(open.current), [videoH]);
  const target = picture ? 1 : 0;
  useLayoutEffect(() => {
    if (open.current === target) {
      draw(target);
      return;
    }
    if (reduceMotion()) {
      draw(target);
      tile.placeNow();
      return;
    }
    const from = open.current;
    const start = now();
    const tick = () => {
      const u = Math.min(1, (now() - start) / (CARD_GROW * 1000));
      draw(from + (target - from) * easeOut(u));
      // The layer with the picture, frame by frame.
      tile.placeNow();
      tween.current = u < 1 ? requestAnimationFrame(tick) : 0;
    };
    tween.current = requestAnimationFrame(tick);
    return () => {
      if (tween.current) cancelAnimationFrame(tween.current);
      tween.current = 0;
    };
  }, [target]);

  return (
    <div
      ref={ref}
      role="group"
      className="fixed flex flex-col zen-font"
      style={{
        ...anchorStyle(corner),
        width,
        background: "rgba(28, 28, 30, 0.72)",
        border: `${CARD_EDGE}px solid var(--tile-edge)`,
        boxShadow: `${SHEEN}, ${held ? FLOAT_HELD_SHADOW : FLOAT_SHADOW}`,
        backdropFilter: "blur(28px) saturate(180%)",
        WebkitBackdropFilter: "blur(28px) saturate(180%)",
        transition: "box-shadow 0.18s ease-out",
        willChange: "transform",
        zIndex: 40,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      {...handlers}
      aria-label={roomName ? `Call in ${roomName}. Tap the tile to open the call.` : "Call. Tap the tile to open the call."}
      data-testid="voice-call-tile"
      data-corner={corner}
      data-picture={picture ?? "none"}
    >
      <div
        ref={mediaRef}
        className="relative overflow-hidden"
        style={{ flex: "0 0 auto", width: "100%", background: backdrop === "remote" ? "#000" : backdrop ? "#1c1c1e" : "transparent" }}
        aria-hidden={picture ? undefined : true}
        data-testid="voice-call-tile-media"
      >
        {picture === "self" ? <Self /> : null}
        {/* The native layer's rect (someone's video): the band stays below it. */}
        <div
          ref={pictureRef}
          className="relative overflow-hidden"
          style={{ width: "100%" }}
          role={picture ? "img" : undefined}
          aria-label={picture === "remote" ? "The call's video" : picture === "self" ? "Your camera" : undefined}
          data-testid="voice-call-tile-picture"
        >
          {picture === "remote" ? <Remote /> : null}
        </div>
        {picture ? <Duration /> : null}
      </div>
      <Controls />
    </div>
  );
}
