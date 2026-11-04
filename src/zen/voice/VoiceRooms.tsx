import { useEffect, useMemo, useState } from "react";
import { scopeFor } from "../../api/scope";
import { useBackHandler } from "../../lib/androidBack";
import { onForegroundLater } from "../../lib/foreground";
import { useServersStore, type ServerEntry } from "../../stores/servers";
import { serverDisplayName } from "../homeView";
import { subscribeAppEvents } from "../ticketEvents";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "../ZenHeaderBlur";
import { FEATURE_VOICE_ROOMS, fetchVoiceRooms, isVoiceRoomsChanged, type VoiceRoomsResult } from "./voiceApi";
import { useVoiceCall } from "./voiceCall";
import { hostingStateText, roomIsFull, type VoiceRoom } from "./voiceWire";

// Voice rooms on every server this phone is signed in to that hosts them
// (K2's PRD §4.3: each server asked with its own login, never relayed).
// Re-read on each server's `voice_rooms_changed` and on return to the app.
// The 30 s re-read while open is only a backstop: K2 keeps the event
// reliable, so a list that's only right after the backstop is a daemon bug
// to report (K2, 2026-11-04).

const VOICE_HEADER_PX = 64;
const POLL_MS = 30_000;

/** Signed-in servers that host rooms, this one first, then A to Z. */
export function voiceServers(servers: ServerEntry[], tokens: Record<string, string>, activeId: string | null): ServerEntry[] {
  return servers
    .filter((s) => !!tokens[s.id] && scopeFor(s.id).supports(FEATURE_VOICE_ROOMS))
    .sort((a, b) =>
      a.id === activeId ? -1 : b.id === activeId ? 1 : serverDisplayName(a).localeCompare(serverDisplayName(b))
    );
}

/** Show the headset at all: a server hosts rooms, or a call is up. */
export function useVoiceAvailable(): boolean {
  const servers = useServersStore((s) => s.servers);
  const tokens = useServersStore((s) => s.tokens);
  const inCall = useVoiceCall((s) => s.phase !== "idle");
  return inCall || voiceServers(servers, tokens, null).length > 0;
}

function useRooms(server: ServerEntry): VoiceRoomsResult | null {
  const [result, setResult] = useState<VoiceRoomsResult | null>(null);
  useEffect(() => {
    const scope = scopeFor(server.id);
    let alive = true;
    const read = () =>
      void fetchVoiceRooms(scope).then((r) => {
        // A blip keeps what's on screen.
        if (alive) setResult((prev) => (!r.ok && r.code === "unreachable" && prev?.ok ? prev : r));
      });
    read();
    const events = subscribeAppEvents(scope, isVoiceRoomsChanged, read);
    const off = onForegroundLater(`voice-rooms-${server.id}`, read);
    const poll = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      events.stop();
      off();
      clearInterval(poll);
    };
  }, [server.id]);
  return result;
}

function Occupants({ room }: { room: VoiceRoom }) {
  if (room.occupants.length === 0) return <span style={{ color: "#8e8e93" }}>Empty</span>;
  const names = room.occupants.map((o) => o.name ?? o.user);
  const shown = names.slice(0, 3).join(", ");
  return <span>{names.length > 3 ? `${shown} and ${names.length - 3} more` : shown}</span>;
}

function RoomRow({ server, room }: { server: ServerEntry; room: VoiceRoom }) {
  const call = useVoiceCall();
  const here = call.room?.serverId === server.id && call.room.roomId === room.id;
  const full = roomIsFull(room);
  const closed = room.closing || (!!room.unavailable && room.unavailable !== "room_full");
  const label = serverDisplayName(server);
  return (
    <div
      className="flex items-center"
      style={{ gap: 12, padding: "10px 14px", minHeight: 56 }}
      data-testid={`voice-room-${server.id}-${room.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[16px] truncate" style={{ color: "#fff" }}>
          {room.name}
          {room.limit !== null ? (
            <span className="text-[13px]" style={{ color: "#8e8e93" }}>
              {" "}
              · {room.occupants.length}/{room.limit}
            </span>
          ) : null}
        </div>
        <div className="text-[13px] truncate" style={{ color: "#c7c7cc" }}>
          <Occupants room={room} />
        </div>
      </div>
      {here ? (
        <span className="text-[14px]" style={{ color: "#30d158" }} data-testid="voice-room-here">
          {call.phase === "joining" ? "Joining…" : "In call"}
        </span>
      ) : (
        <button
          type="button"
          className="zen-glass zen-glass-pill text-[15px]"
          style={{ minHeight: 34, padding: "0 16px", color: "#fff", opacity: full || closed ? 0.4 : 1 }}
          disabled={full || closed}
          onClick={() =>
            void call.join({
              serverId: server.id,
              serverLabel: label,
              roomId: room.id,
              roomName: room.name,
              limit: room.limit,
            })
          }
          data-testid="voice-room-join"
        >
          {full ? "Full" : room.closing ? "Closing" : "Join"}
        </button>
      )}
    </div>
  );
}

function ServerRooms({ server }: { server: ServerEntry }) {
  const r = useRooms(server);
  const label = serverDisplayName(server);
  return (
    <section style={{ marginBottom: 18 }} data-testid={`voice-server-${server.id}`}>
      <h2 className="text-[13px] uppercase" style={{ color: "#8e8e93", padding: "0 14px 6px", letterSpacing: 0.4 }}>
        {label}
      </h2>
      <div className="k2-tile" style={{ borderRadius: 14, overflow: "hidden" }}>
        {!r ? (
          <p className="text-[14px]" style={{ padding: 14, color: "#8e8e93" }}>
            Loading…
          </p>
        ) : !r.ok ? (
          <p className="text-[14px]" style={{ padding: 14, color: "#8e8e93" }} data-testid="voice-server-problem">
            {r.code === "signin_required"
              ? `Sign in to ${label} again to see its rooms.`
              : r.code === "unreachable"
                ? `Can't reach ${label}.`
                : `Couldn't load ${label}'s rooms.`}
          </p>
        ) : r.list.rooms.length === 0 ? (
          <p className="text-[14px]" style={{ padding: 14, color: "#8e8e93" }}>
            {hostingStateText(r.list.hosting) ?? "No voice rooms yet."}
          </p>
        ) : (
          r.list.rooms.map((room) => <RoomRow key={room.id} server={server} room={room} />)
        )}
      </div>
    </section>
  );
}

export function VoiceRoomsOverlay({ onClose }: { onClose: () => void }) {
  const servers = useServersStore((s) => s.servers);
  const tokens = useServersStore((s) => s.tokens);
  const activeId = useServersStore((s) => s.activeServerId);
  const notice = useVoiceCall((s) => s.notice);
  const clearNotice = useVoiceCall((s) => s.clearNotice);
  const [headerRef, headerPx] = useMeasuredHeight(VOICE_HEADER_PX);
  useBackHandler(true, onClose);
  const list = useMemo(() => voiceServers(servers, tokens, activeId), [servers, tokens, activeId]);

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "#000", zIndex: 6 }} data-testid="overlay-voice">
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        style={{ zIndex: 3, paddingTop: "env(safe-area-inset-top)", pointerEvents: "none" }}
      >
        <ZenHeaderBlur testId="voice-header-blur" />
        <div ref={headerRef} className="relative w-full min-w-0">
          <div
            className="grid items-center"
            style={{ gridTemplateColumns: "1fr auto 1fr", minHeight: 44, padding: "12px 12px 8px", columnGap: 8 }}
          >
            <button
              type="button"
              className="text-[17px] justify-self-start zen-glass zen-glass-pill"
              style={{ minHeight: 34, padding: "0 14px", color: "#fff", pointerEvents: "auto" }}
              onClick={onClose}
              data-testid="voice-done"
            >
              Done
            </button>
            <h1 className="text-[17px] font-semibold pointer-events-none zen-header-text">Rooms</h1>
            <span />
          </div>
        </div>
      </header>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingTop: underHeaderPadding(headerPx),
          paddingLeft: 12,
          paddingRight: 12,
          paddingBottom: "calc(96px + var(--safe-bottom))",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {notice ? (
          <button
            type="button"
            className="w-full text-left text-[14px] k2-tile"
            style={{ padding: 12, marginBottom: 14, borderRadius: 12, color: "#ffd60a" }}
            onClick={clearNotice}
            data-testid="voice-notice"
          >
            {notice}
          </button>
        ) : null}
        {list.length === 0 ? (
          <p className="text-[14px]" style={{ padding: 14, color: "#8e8e93" }} data-testid="voice-empty">
            No voice rooms yet. Rooms show here from Linux servers with Pro that you're signed in to.
          </p>
        ) : (
          list.map((s) => <ServerRooms key={s.id} server={s} />)
        )}
      </div>
      <CallBar />
    </div>
  );
}

/** The current call, docked at the bottom: the room, Mute and Leave. */
export function CallBar() {
  const call = useVoiceCall();
  if (call.phase === "idle" || !call.room) return null;
  const status = call.phase === "joining" ? "Joining…" : call.phase === "reconnecting" ? "Reconnecting…" : "Connected";
  return (
    <div
      className="absolute left-0 right-0 flex items-center k2-tile"
      style={{
        bottom: "calc(12px + var(--safe-bottom))",
        margin: "0 12px",
        padding: "10px 12px",
        gap: 10,
        borderRadius: 16,
        zIndex: 4,
      }}
      data-testid="voice-call-bar"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[15px] truncate" style={{ color: "#fff" }}>
          {call.room.roomName}
        </div>
        <div className="text-[12px] truncate" style={{ color: call.phase === "reconnecting" ? "#ffd60a" : "#30d158" }}>
          {status} · {call.room.serverLabel}
        </div>
      </div>
      <button
        type="button"
        className="zen-glass zen-glass-pill text-[14px]"
        style={{ minHeight: 34, padding: "0 14px", color: "#fff" }}
        aria-pressed={call.muted}
        onClick={() => call.setMuted(!call.muted)}
        data-testid="voice-mute"
      >
        {call.muted ? "Unmute" : "Mute"}
      </button>
      <button
        type="button"
        className="text-[14px]"
        style={{ minHeight: 34, padding: "0 14px", color: "#fff", background: "#ff453a", borderRadius: 17 }}
        onClick={() => void call.leave()}
        data-testid="voice-leave"
      >
        Leave
      </button>
    </div>
  );
}
