import { create } from "zustand";
import type { VoiceOccupant, VoiceRoom } from "./voiceWire";

// What the phone knows about the people and rooms of a call, for the call
// screen (Sew's kit asks for names by Sew's member id and channel). The
// engine has ids only, and there's no Sew member lookup through K2 yet, so
// the rooms lists are the source: each occupant can carry its `memberId`.
// Written by the Rooms overlay on every read; no kit imports here, so this
// stays in the startup bundle while the kit loads with the call screen.

type VoiceNames = {
  /** Server id → its rooms as last read. */
  rooms: Record<string, VoiceRoom[]>;
  /** Server id → an agent there may read its rooms' transcripts. */
  agentReaders: Record<string, boolean>;
  put(serverId: string, rooms: VoiceRoom[], agentReaders?: boolean): void;
};

export const useVoiceNames = create<VoiceNames>((set) => ({
  rooms: {},
  agentReaders: {},
  put: (serverId, rooms, agentReaders = false) =>
    set((s) =>
      s.rooms[serverId] === rooms && s.agentReaders[serverId] === agentReaders
        ? s
        : { rooms: { ...s.rooms, [serverId]: rooms }, agentReaders: { ...s.agentReaders, [serverId]: agentReaders } }
    ),
}));

/** A room by its slug, or by Sew's channel id (what the engine reports
 *  after a moderator's move). */
export function roomByKey(rooms: VoiceRoom[] | undefined, key: string): VoiceRoom | null {
  return rooms?.find((r) => r.id === key || (r.channelId !== undefined && r.channelId === key)) ?? null;
}

/** The occupant with this Sew member id, in `room` first, then anywhere
 *  on the server. */
export function occupantByMember(
  rooms: VoiceRoom[] | undefined,
  memberId: string,
  room?: VoiceRoom | null
): VoiceOccupant | null {
  const inRoom = room?.occupants.find((o) => o.memberId === memberId);
  if (inRoom) return inRoom;
  for (const r of rooms ?? []) {
    const o = r.occupants.find((x) => x.memberId === memberId);
    if (o) return o;
  }
  return null;
}

export function __resetVoiceNamesForTests(): void {
  useVoiceNames.setState({ rooms: {}, agentReaders: {} });
}
