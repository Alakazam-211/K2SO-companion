import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { scopeFor } from "../../api/scope";
import { useBackHandler } from "../../lib/androidBack";
import { useSwipeBack } from "../../lib/useSwipeBack";
import { isIosWebView } from "../../lib/nativePicker";
import { onForegroundLater } from "../../lib/foreground";
import { useServersStore, type ServerEntry } from "../../stores/servers";
import { serverDisplayName } from "../homeView";
import { subscribeAppEvents } from "../ticketEvents";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "../ZenHeaderBlur";
import { FEATURE_VOICE_ROOMS, fetchVoiceRooms, isVoiceRoomsChanged, type VoiceRoomsResult } from "./voiceApi";
import { shareCallLog } from "./sewVoice";
import { useLiveVideo, VideoTile } from "./videoLayer";
import { canJoinWithCamera, useVoiceCall, type CallRoom } from "./voiceCall";
import { useVoiceNames } from "./voiceNames";
import { hostingStateText, meOffer, roomIsFull, type VoiceRoom, type VoiceRoomsList } from "./voiceWire";

// Voice rooms on every server this phone is signed in to that hosts them
// (K2's PRD §4.3: each server asked with its own login, never relayed).
// Re-read on each server's `voice_rooms_changed` and on return to the app.
// The 30 s re-read while open is only a backstop: K2 keeps the event
// reliable, so a list that's only right after the backstop is a daemon bug
// to report (K2, 2026-11-04).

const VOICE_HEADER_PX = 64;
const POLL_MS = 30_000;
/** The call bar's height without video, and the air above it. */
const CALL_BAR_PX = 60;
const CALL_BAR_AIR = 36;

/** Sew's call kit, loaded with the first call screen (never at start). */
const KitCall = lazy(() => import("./kit/KitCall"));

/** Signed-in servers that host rooms, this one first, then A to Z. */
export function voiceServers(
  servers: ServerEntry[],
  tokens: Record<string, string>,
  activeId: string | null
): ServerEntry[] {
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

/** A video camera, for "Join with camera". */
function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 13l5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

function RoomRow({ server, room }: { server: ServerEntry; room: VoiceRoom }) {
  const call = useVoiceCall();
  const here = call.room?.serverId === server.id && call.room.roomId === room.id;
  const full = roomIsFull(room);
  const closed = room.closing || (!!room.unavailable && room.unavailable !== "room_full");
  const label = serverDisplayName(server);
  const join = (camera: boolean) =>
    void call.join(
      { serverId: server.id, serverLabel: label, roomId: room.id, roomName: room.name, limit: room.limit },
      camera ? { camera: true } : undefined
    );
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
        <>
          {canJoinWithCamera() && !full && !closed ? (
            <button
              type="button"
              className="zen-glass zen-glass-pill flex items-center justify-center"
              style={{ minHeight: 34, width: 40, padding: 0, color: "#fff" }}
              onClick={() => join(true)}
              aria-label={`Join ${room.name} with camera`}
              data-testid="voice-room-join-camera"
            >
              <CameraIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="zen-glass zen-glass-pill text-[15px]"
            style={{ minHeight: 34, padding: "0 16px", color: "#fff", opacity: full || closed ? 0.4 : 1 }}
            disabled={full || closed}
            onClick={() => join(false)}
            data-testid="voice-room-join"
          >
            {full ? "Full" : room.closing ? "Closing" : "Join"}
          </button>
        </>
      )}
    </div>
  );
}

/** Your call on this server from another device, or from this phone before
 *  the app was killed. The daemon never claims it live (Sew's presence lags
 *  about 40 s), so the line hedges. */
function MeOffer({ server, list }: { server: ServerEntry; list: VoiceRoomsList }) {
  const call = useVoiceCall();
  const label = serverDisplayName(server);
  const offer = meOffer(list.me, label);
  const room = list.rooms.find((x) => x.id === list.me?.roomId);
  if (!offer || !room || (call.room?.serverId === server.id && call.room.roomId === room.id)) return null;
  return (
    <div className="flex items-center" style={{ gap: 10, padding: "10px 14px" }} data-testid="voice-me-offer">
      <span className="min-w-0 flex-1 text-[14px]" style={{ color: "#c7c7cc" }}>
        {offer.line}
      </span>
      <button
        type="button"
        className="zen-glass zen-glass-pill text-[14px] shrink-0"
        style={{ minHeight: 34, padding: "0 14px", color: "#30d158" }}
        onClick={() =>
          void call.join({
            serverId: server.id,
            serverLabel: label,
            roomId: room.id,
            roomName: room.name,
            limit: room.limit,
          })
        }
        data-testid="voice-me-action"
      >
        {offer.action === "rejoin" ? "Rejoin" : "Move here"}
      </button>
    </div>
  );
}

function ServerRooms({ server }: { server: ServerEntry }) {
  const r = useRooms(server);
  const label = serverDisplayName(server);
  // The call screen names people and rooms from these.
  const put = useVoiceNames((s) => s.put);
  const rooms = r?.ok ? r.list.rooms : null;
  useEffect(() => {
    if (rooms) put(server.id, rooms);
  }, [put, rooms, server.id]);
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
            {r.code === "device_session_ended"
              ? `This phone was signed out of ${label}. Pair it again to see its rooms.`
              : r.code === "signin_required"
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
          <>
            <MeOffer server={server} list={r.list} />
            {r.list.rooms.map((room) => (
              <RoomRow key={room.id} server={server} room={room} />
            ))}
          </>
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
  const inCall = useVoiceCall((s) => s.phase !== "idle");
  const [headerRef, headerPx] = useMeasuredHeight(VOICE_HEADER_PX);
  // The left-edge swipe goes back too, as on every other screen. Not while
  // a recording notice waits: that sheet is the person's to answer.
  const consentUp = useVoiceCall((s) => s.consent !== null);
  const swipeRef = useSwipeBack(onClose, { enabled: !consentUp });
  // The rooms scroll clear of the call bar, taller with video.
  const [barRef, barPx] = useMeasuredHeight(CALL_BAR_PX);
  const barSpace = (inCall ? Math.max(barPx, CALL_BAR_PX) : CALL_BAR_PX) + CALL_BAR_AIR;
  useBackHandler(true, onClose);
  const list = useMemo(() => voiceServers(servers, tokens, activeId), [servers, tokens, activeId]);

  return (
    <div
      ref={swipeRef}
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-voice"
    >
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
            {/* Back, not Done (Rosson): the call area sits over the page it was
                opened from, floating tile or menu, and closing returns there. */}
            <button
              type="button"
              className="flex items-center justify-center justify-self-start shrink-0 zen-glass zen-glass-pill"
              style={{ width: 34, height: 34, color: "#fff", pointerEvents: "auto" }}
              onClick={onClose}
              aria-label="Back"
              data-testid="voice-done"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
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
          paddingBottom: `calc(${barSpace}px + var(--safe-bottom))`,
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
        <SendCallLog />
      </div>
      <ConsentSheet />
      <CallBar measureRef={barRef} />
    </div>
  );
}

/** "Send call log", under the rooms: where the person is when a call
 *  misbehaves, and still there after it ended. The phone's call engine
 *  only (iOS). */
function SendCallLog() {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!isIosWebView()) return null;
  const send = async () => {
    setBusy(true);
    setFailed((await shareCallLog()) === "failed");
    setBusy(false);
  };
  return (
    <div style={{ padding: "4px 14px 14px" }} data-testid="voice-call-log">
      <button
        type="button"
        className="zen-glass zen-glass-pill text-[14px]"
        style={{ minHeight: 34, padding: "0 14px", color: "#fff", opacity: busy ? 0.5 : 1 }}
        disabled={busy}
        onClick={() => void send()}
        data-testid="voice-send-log"
      >
        Send call log
      </button>
      <p className="text-[12px]" style={{ color: "#8e8e93", marginTop: 6 }}>
        {failed
          ? "Couldn't get the call log. Try again."
          : "For when a call misbehaves: call events and error codes with times. No names, addresses or audio."}
      </p>
    </div>
  );
}

/** Catch the call store up with the engine, naming an adopted call from
 *  the saved servers (the room's name comes back with the next rooms read). */
export function resyncVoiceCall(): Promise<void> {
  return useVoiceCall.getState().resync((serverId) => {
    const server = useServersStore.getState().servers.find((s) => s.id === serverId);
    return { serverLabel: server ? serverDisplayName(server) : "", roomName: "Voice room", limit: null };
  });
}

/** A recorded room's notice, in Sew's kit's words: the answers in the kit's
 *  order, none of them a default. Nobody is recorded without a yes. */
export function ConsentSheet() {
  const sheet = useVoiceCall((s) => s.consent);
  const answer = useVoiceCall((s) => s.answerConsent);
  if (!sheet) return null;
  return (
    <div
      className="absolute left-0 right-0 k2-tile"
      style={{
        bottom: "calc(84px + var(--safe-bottom))",
        margin: "0 12px",
        padding: 16,
        borderRadius: 16,
        zIndex: 5,
        background: "#1c1c1e",
      }}
      role="dialog"
      aria-labelledby="voice-consent-title"
      data-testid="voice-consent"
    >
      <h2 id="voice-consent-title" className="text-[17px] font-semibold" style={{ color: "#fff", marginBottom: 8 }}>
        {sheet.title}
      </h2>
      <p className="text-[14px]" style={{ color: "#c7c7cc", whiteSpace: "pre-line", marginBottom: 14 }}>
        {sheet.text}
      </p>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {sheet.choices.map((c) => (
          <button
            key={c.label}
            type="button"
            className="zen-glass zen-glass-pill text-[15px]"
            style={{ minHeight: 40, padding: "0 14px", color: "#fff" }}
            onClick={() => void answer(c.granted)}
            data-testid="voice-consent-choice"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** While Sew's kit loads: the room and its state. */
function CallLine({ room, status }: { room: CallRoom; status: string }) {
  return (
    <div className="min-w-0" data-testid="voice-call-line">
      <div className="text-[15px] truncate" style={{ color: "#fff" }}>
        {room.roomName}
      </div>
      <div className="text-[12px] truncate" style={{ color: "#30d158" }}>
        {status} · {room.serverLabel}
      </div>
    </div>
  );
}

/** The current call, docked at the bottom: Sew's kit (kit/KitCall.tsx):
 *  the people, the video on its person's tile (the phone's native layer),
 *  the E2EE status and quality, Mute, Deafen and Leave. */
export function CallBar({ measureRef }: { measureRef?: (el: HTMLElement | null) => void }) {
  const call = useVoiceCall();
  const live = useLiveVideo();
  if (call.phase === "idle" || !call.room) return null;
  const held = call.phase === "joining" && call.consent?.ask === "join";
  return (
    <div
      ref={measureRef}
      className="absolute left-0 right-0 k2-tile"
      style={{
        bottom: "calc(12px + var(--safe-bottom))",
        margin: "0 12px",
        padding: "10px 12px",
        borderRadius: 16,
        zIndex: 4,
      }}
      data-testid="voice-call-bar"
    >
      {held ? (
        <p className="text-[12px]" style={{ color: "#ffd60a", margin: "0 0 8px" }} data-testid="voice-call-held">
          Waiting for your answer…
        </p>
      ) : null}
      <Suspense
        fallback={
          <>
            {/* The recording sheet sits over the tile: the layer steps under the page. */}
            {live ? <VideoTile covered={!!call.consent} /> : null}
            <CallLine room={call.room} status={call.phase === "joining" ? "Joining…" : call.phase === "reconnecting" ? "Reconnecting…" : "Connected"} />
          </>
        }
      >
        <KitCall />
      </Suspense>
    </div>
  );
}
