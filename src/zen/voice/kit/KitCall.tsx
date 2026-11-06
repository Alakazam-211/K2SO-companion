import "@sew/voice/theme.css";
import "@sew/voice/styles.css";
import "./sewKit.css";
import { useEffect, useMemo, type MouseEvent, type ReactNode } from "react";
import type { Member } from "@sew/client/proto";
import { CallBar, CallView, useVoice, VoiceProvider, type HostTileInfo, type VoiceUi } from "@sew/voice";
import { useServersStore } from "../../../stores/servers";
import { serverDisplayName } from "../../homeView";
import { LayerSlot, useLayerPlacement, VideoTile } from "../videoLayer";
import { useVoiceCall, type CallRoom } from "../voiceCall";
import { occupantByMember, roomByKey, useVoiceNames } from "../voiceNames";
import type { VoiceRoom } from "../voiceWire";
import { kitChannelId, kitRoomOf, kitSelfId, sewKit } from "./sewKit";

// The call screen's kit parts (Sew's @sew/voice), loaded with the call
// screen so the kit never weighs on the app's start:
//   - the kit's CallView: one tile per person (speaking ring, mute mark),
//     from the plugin's roster. The person whose picture the native layer
//     shows gets a video tile: `renderTile` draws the phone's LayerSlot in
//     its rect, `onTileRect` puts the layer there (videoLayer.tsx);
//   - the kit's CallBar, docked: E2EE status, quality, the security code,
//     Mute, Deafen, Leave.
// The phone's own parts stay around it in VoiceRooms.tsx: the recording
// notice (ConsentSheet, wired to CallKit and the background notice; the
// kit's RecordingConsent is never placed), and the mini tile outside the
// call screen (videoLayer.tsx).
//
// Hidden until K2 passes Sew's API through and a gateway feeds the store:
// RecordingBadge/RecordingControls (need the store), VoiceChannelMembers
// (not placed). Camera and screen stay hidden: the phone doesn't send video
// here (layerVideo.ts). The bar's device check opens the webview's own mic
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
    avatar: (memberId: string, size: number): ReactNode => {
      const p = person(memberId);
      return <Avatar name={p.name} color={p.color} size={size} />;
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

/** The people, and the video on the tile of whoever the layer shows. */
function People({ covered }: { covered: boolean }) {
  const v = useVoice();
  const video = useVoiceCall((s) => s.video);
  const place = useLayerPlacement(covered);
  if (v.phase === "idle" || !v.channelId) return null;
  const hosted = v.participants.some((p) => p.camera || p.screen);
  return (
    <>
      {/* The call has video but the kit can't tell whose yet: the tile alone. */}
      {video && !hosted ? <VideoTile covered={covered} /> : null}
      <CallView
        channelId={v.channelId}
        renderTile={() => <LayerSlot />}
        onTileRect={(_t: HostTileInfo, rect) => place(rect)}
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
    const { memberRecord, ...names } = kitNames(room, rooms, username);
    return {
      controller: kit.controller,
      store: kit.store,
      ...names,
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
        <People covered={covered} />
        <Bar room={room} />
      </VoiceProvider>
    </div>
  );
}
