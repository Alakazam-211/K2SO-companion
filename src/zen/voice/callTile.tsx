import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Headphones, HeadphoneOff, Lock, Mic, MicOff, PhoneOff } from "lucide-react";
import { anchorStyle, FLOAT_HELD_SHADOW, FLOAT_SHADOW, useCornerDrag, useFadeIn, useLiveVideo } from "./videoLayer";
import { useVoiceCall } from "./voiceCall";

// The call tile: a call with no live picture, while the call area is
// closed (Rosson 2026-11-06). Where the mini video tile would float, the
// same corner and the same motion (useCornerDrag: drag, velocity snap on
// the spring, catch, lift, haptic, Reduce Motion, one saved corner), with
// Mute, Deafen and Hang up on it. When someone's picture starts playing it
// becomes the mini video tile in place, and back when it stops: the two
// are never up together (`useLiveVideo` decides both).
//
// Page-only: no native layer under it, so no pipFrame. The buttons are the
// call bar's own actions through the store (`setMuted`, `setDeafened`,
// `leave`: the plugin's `mute {muted?, deafened?}` and `leave`), the state
// the engine's (your own row: muted, deafened, a moderator's mute or deafen,
// a lost SPEAK). The finger is taken only once it drags, so a tap on a
// button is the button's; a tap on the tile's edge opens the call.

export const CALL_TILE_BUTTON = 40;
const GAP = 8;
const PAD = 8;
export const CALL_TILE_W = CALL_TILE_BUTTON * 3 + GAP * 2 + PAD * 2;
export const CALL_TILE_H = CALL_TILE_BUTTON + PAD * 2;

/** The call tile shows while a call is up, its area closed, and no picture
 *  plays (the mini video tile's moment is the opposite). */
export function useCallTileShown(callViewOpen: boolean): boolean {
  const live = useLiveVideo();
  const inCall = useVoiceCall((s) => s.phase !== "idle" && !!s.room);
  return inCall && !live && !callViewOpen;
}

export function CallTile({ callViewOpen, onOpen }: { callViewOpen: boolean; onOpen: () => void }) {
  const shown = useCallTileShown(callViewOpen);
  if (!shown || typeof document === "undefined") return null;
  return createPortal(<Tile onOpen={onOpen} />, document.body);
}

const GLASS_BG = "rgba(255, 255, 255, 0.1)";
const GLASS_EDGE = "rgba(255, 255, 255, 0.22)";
const SHEEN = "inset 0 1px 0 rgba(255, 255, 255, 0.28)";

function TileButton({
  label,
  pressed,
  off,
  danger,
  locked,
  onPress,
  testId,
  children,
}: {
  label: string;
  pressed?: boolean;
  /** Shown "off" (muted, deafened): white, as the call bar's. */
  off?: boolean;
  danger?: boolean;
  /** Held by a moderator: shows it, does nothing (still drags the tile). */
  locked?: boolean;
  onPress: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="relative flex items-center justify-center shrink-0"
      style={{
        width: CALL_TILE_BUTTON,
        height: CALL_TILE_BUTTON,
        borderRadius: CALL_TILE_BUTTON / 2,
        padding: 0,
        border: `0.5px solid ${danger ? "#ff453a" : off ? "#fff" : GLASS_EDGE}`,
        background: danger ? "#ff453a" : off ? "#fff" : GLASS_BG,
        boxShadow: danger || off ? "none" : SHEEN,
        color: danger || off ? "#000" : "#fff",
        opacity: locked ? 0.55 : 1,
      }}
      // Not `disabled`: WebKit sends a disabled button no pointer events, and
      // a drag may start on any part of the tile.
      aria-disabled={locked || undefined}
      aria-pressed={pressed}
      aria-label={label}
      onClick={() => {
        if (!locked) onPress();
      }}
      data-testid={testId}
      data-locked={locked ? "yes" : undefined}
    >
      {children}
      {locked ? (
        <span
          className="absolute flex items-center justify-center"
          style={{ right: -2, bottom: -2, width: 16, height: 16, borderRadius: 8, background: "#1c1c1e", color: "#fff" }}
          aria-hidden="true"
        >
          <Lock size={9} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

function Tile({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const muted = useVoiceCall((s) => s.muted);
  const deafened = useVoiceCall((s) => s.deafened);
  const muteLocked = useVoiceCall((s) => s.muteLocked);
  const deafLocked = useVoiceCall((s) => s.deafLocked);
  const roomName = useVoiceCall((s) => s.room?.roomName ?? "");
  const { corner, held, handlers } = useCornerDrag(ref, {
    captureOnDrag: true,
    // The tile's edge opens the call; a button's tap is the button's.
    onTap: (target) => {
      const hit = target instanceof Element ? target.closest("button") : null;
      if (!hit || !ref.current?.contains(hit)) onOpen();
    },
  });
  useFadeIn(ref);
  const deaf = deafened || deafLocked;
  const micOff = muted || muteLocked || deaf;
  const call = useVoiceCall.getState;
  return (
    <div
      ref={ref}
      role="group"
      className="fixed flex items-center"
      style={{
        ...anchorStyle(corner),
        width: CALL_TILE_W,
        height: CALL_TILE_H,
        padding: PAD,
        gap: GAP,
        borderRadius: CALL_TILE_H / 2,
        background: "rgba(28, 28, 30, 0.72)",
        border: "1px solid var(--tile-edge)",
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
    >
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
      <TileButton label="Hang up" danger onPress={() => void call().leave()} testId="voice-call-tile-leave">
        <PhoneOff size={18} aria-hidden="true" />
      </TileButton>
    </div>
  );
}
