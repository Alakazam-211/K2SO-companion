import "@sew/voice/theme.css";
import "@sew/voice/styles.css";
import "./sewKit.css";
import { useCallback, useEffect, useMemo, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { Member } from "@sew/client/proto";
import { CallBar, CallView, useVoice, VoiceProvider, type HostTileInfo, type VoiceUi } from "@sew/voice";
import { useServersStore } from "../../../stores/servers";
import { serverDisplayName } from "../../homeView";
import { LayerSlot, SelfView, useLayerPlacement, useLiveVideo, VideoTile } from "../videoLayer";
import { useVoiceCall, type CallRoom } from "../voiceCall";
import { occupantByMember, roomByKey, useVoiceNames } from "../voiceNames";
import type { VoiceRoom } from "../voiceWire";
import type { LayerVideo } from "./layerVideo";
import { kitChannelId, kitRoomOf, kitSelfId, sewKit } from "./sewKit";

// The call screen's kit parts (Sew's @sew/voice), loaded with the call
// screen so the kit never weighs on the app's start:
//   - the kit's CallView: one tile per person (speaking ring, mute mark),
//     from the plugin's roster. The person whose picture the native layer
//     shows gets a video tile: `renderTile` draws the phone's LayerSlot in
//     its rect, `onTileRect` puts the layer there (videoLayer.tsx);
//   - the kit's CallBar, docked: E2EE status, quality, the security code,
//     Mute, Deafen, the camera (with its switch while on) and Leave;
//   - your own tile, while your camera is on: `SelfView` in its rect (the
//     kit's `local:camera` sink, mirrored for the front camera, "Camera
//     paused" in the background). Never the native layer, never PiP.
// The phone's own parts stay around it in VoiceRooms.tsx: the recording
// notice (ConsentSheet, wired to CallKit and the background notice; the
// kit's RecordingConsent is never placed), and the mini tile outside the
// call screen (videoLayer.tsx).
//
// Hidden until K2 passes Sew's API through and a gateway feeds the store:
// RecordingBadge/RecordingControls (need the store), VoiceChannelMembers
// (not placed). The screen button stays hidden: no phone screen share yet
// (layerVideo.ts). The bar's device check opens the webview's own mic
// prompt, so its button is hidden and never answers here (sewKit.css,
// `guard`).

const FALLBACK_NAME = "Someone";

/** The device check's button (the kit's `voice-devices`). */
const DEVICE_CHECK = '[data-testid="voice-devices"]';

/** No device check on the phone: a tap on its button never reaches it. */
function guard(e: MouseEvent): void {
  if ((e.target as Element | null)?.closest?.(DEVICE_CHECK)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function Avatar({ name, color, size }: { name: string; color: string | null; size: number }) {
  // The kit asks 64 for a call tile; the phone's tiles are smaller.
  const px = size >= 64 ? 46 : size;
  return (
    <span
      className="k2-kit-avatar"
      style={{ width: px, height: px, fontSize: Math.round(px * 0.4), background: color ?? "#3a3a3c" }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function useLayerVideo<T>(video: LayerVideo, read: (v: LayerVideo) => T): T {
  const sub = useCallback((fn: () => void) => video.subscribe(fn), [video]);
  return useSyncExternalStore(sub, () => read(video), () => read(video));
}

/** Under a call tile's avatar: "Video starting…" for a few seconds before
 *  someone's first frame (then the plain avatar), and your camera's state
 *  when this webview can't draw your self-view. */
export function AvatarNote({ memberId, video }: { memberId: string; video: LayerVideo }) {
  const starting = useLayerVideo(video, (v) => v.starting() === memberId);
  const self = memberId === kitSelfId();
  const undrawn = useLayerVideo(video, (v) => self && v.selfUndrawn());
  const paused = useLayerVideo(video, (v) => v.selfState() === "paused");
  const text = starting ? "Video starting…" : undrawn ? (paused ? "Camera paused" : "Camera on") : null;
  if (!text) return null;
  return (
    <span className="k2-kit-avatar-note" style={{ color: "#8e8e93", fontSize: 11 }} data-testid="voice-avatar-note">
      {text}
    </span>
  );
}

/** Your own tile's video rect while your camera is on. */
function Self({ handle, video }: { handle: HostTileInfo["handle"]; video: LayerVideo }) {
  const mirrored = useLayerVideo(video, (v) => v.selfMirrored());
  const paused = useLayerVideo(video, (v) => v.selfState() === "paused");
  return <SelfView handle={handle} mirrored={mirrored} paused={paused} />;
}

/** Names for the kit, from what the phone knows: the rooms lists (each
 *  occupant can carry Sew's member id) and your own name on the server. */
export function kitNames(
  room: CallRoom | null,
  rooms: Record<string, VoiceRoom[]>,
  username: (serverId: string) => string | null
) {
  const listed = (channelId: string) => {
    const r = kitRoomOf(channelId);
    return r ? { server: r.serverId, room: roomByKey(rooms[r.serverId], r.roomKey), roomKey: r.roomKey } : null;
  };
  const here = room ? roomByKey(rooms[room.serverId], room.roomId) : null;
  const person = (memberId: string) => {
    const o = room ? occupantByMember(rooms[room.serverId], memberId, here) : null;
    if (o) return { name: o.name ?? o.user, color: o.color };
    if (room && memberId === kitSelfId()) return { name: username(room.serverId) ?? "You", color: null };
    return { name: FALLBACK_NAME, color: null };
  };
  return {
    /** The kit's member record for someone the rooms list names (`null`:
     *  nobody here knows them). Only the name is real: the kit reads
     *  `display_name` alone, the rest fills the type. */
    memberRecord: (memberId: string): Member | null => {
      const o = room ? occupantByMember(rooms[room.serverId], memberId, here) : null;
      if (!o) return null;
      return {
        id: memberId,
        display_name: o.name ?? o.user,
        username: o.user,
        kind: "person",
        install_role: "member",
        deactivated: false,
        created_at: new Date(0).toISOString(),
      };
    },
    memberName: (memberId: string) => person(memberId).name,
    avatar: (memberId: string, size: number, video?: LayerVideo): ReactNode => {
      const p = person(memberId);
      const avatar = <Avatar name={p.name} color={p.color} size={size} />;
      // A call tile (the kit asks 64): room for its note.
      if (!video || size < 64) return avatar;
      return (
        <span className="k2-kit-avatar-stack">
          {avatar}
          <AvatarNote memberId={memberId} video={video} />
        </span>
      );
    },
    channelName: (channelId: string) => {
      const l = listed(channelId);
      const mine = room && l && l.server === room.serverId && (l.roomKey === room.roomId || l.room?.id === room.roomId);
      const name = l?.room?.name ?? (mine ? room.roomName : null) ?? "Voice room";
      const label = mine ? room.serverLabel : null;
      return label ? `${name} · ${label}` : name;
    },
  };
}

/** The people, the video on the tile of whoever the layer shows, and your
 *  own camera on yours. */
function People({ covered, video }: { covered: boolean; video: LayerVideo }) {
  const v = useVoice();
  // Someone else's picture plays (never yours: the sink never shows you).
  const playing = useLiveVideo();
  const others = useLayerVideo(video, (x) => x.othersPlaying());
  const live = playing && others;
  const place = useLayerPlacement(covered);
  if (v.phase === "idle" || !v.channelId) return null;
  const hosted = v.participants.some((p) => !p.local && (p.camera || p.screen));
  return (
    <>
      {/* The picture plays but the kit can't tell whose yet: the tile alone. */}
      {live && !hosted ? <VideoTile covered={covered} /> : null}
      <CallView
        channelId={v.channelId}
        renderTile={(t: HostTileInfo) => (t.participant.local ? <Self handle={t.handle} video={video} /> : <LayerSlot />)}
        // The layer goes on someone else's tile only: never yours.
        onTileRect={(t: HostTileInfo, rect) => {
          if (!t.participant.local) place(rect);
        }}
        tileChrome="below"
      />
    </>
  );
}

/** Before the plugin's first state (the mic prompt, the join on its way):
 *  the room and a way out. */
function Joining({ room }: { room: CallRoom }) {
  const leave = useVoiceCall((s) => s.leave);
  return (
    <div className="flex items-center" style={{ gap: 10 }} data-testid="voice-kit-joining">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] truncate" style={{ color: "#fff" }}>
          {room.roomName}
        </div>
        <div className="text-[12px] truncate" style={{ color: "#30d158" }}>
          Joining… · {room.serverLabel}
        </div>
      </div>
      <button
        type="button"
        className="text-[14px]"
        style={{ minHeight: 34, padding: "0 14px", color: "#fff", background: "#ff453a", borderRadius: 17, border: 0 }}
        onClick={() => void leave()}
        data-testid="voice-kit-cancel"
      >
        Leave
      </button>
    </div>
  );
}

function Bar({ room }: { room: CallRoom }) {
  const v = useVoice();
  if (v.phase === "idle") return <Joining room={room} />;
  return <CallBar docked />;
}

/** The kit's part of the call bar. */
export default function KitCall() {
  const kit = sewKit();
  const room = useVoiceCall((s) => s.room);
  const rooms = useVoiceNames((s) => s.rooms);
  const covered = useVoiceCall((s) => !!s.consent);
  const servers = useServersStore((s) => s.servers);
  // A new call starts clean: the kit keeps its last line after a call ends.
  const key = room ? kitChannelId(room.serverId, room.roomId) : null;
  useEffect(() => {
    if (key) kit.controller.dismissNotice();
  }, [key, kit]);
  const ui = useMemo<VoiceUi>(() => {
    const username = (id: string) => {
      const s = servers.find((x) => x.id === id);
      return s ? s.username || serverDisplayName(s) : null;
    };
    const { memberRecord, avatar, ...names } = kitNames(room, rooms, username);
    return {
      controller: kit.controller,
      store: kit.store,
      ...names,
      avatar: (memberId: string, size: number) => avatar(memberId, size, kit.video),
      // No Sew member lookup through K2 yet: the rooms list is the phone's
      // member loader (the kit shows a name at once for those it knows);
      // anyone else keeps the fallback.
      wantMembers: (ids: string[]) => {
        const known = ids.map(memberRecord).filter((m): m is Member => m !== null);
        if (known.length) kit.store.applyMembers(known);
      },
    };
  }, [kit, room, rooms, servers]);
  if (!room) return null;
  return (
    <div className="sew-kit k2-kit-call" onClickCapture={guard} data-testid="voice-kit">
      <VoiceProvider value={ui}>
        <People covered={covered} video={kit.video} />
        <Bar room={room} />
      </VoiceProvider>
    </div>
  );
}
