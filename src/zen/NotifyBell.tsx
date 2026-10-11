import { useEffect } from "react";
import { useServersStore } from "../stores/servers";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
import { connectNotifyPrefsEvents } from "./ticketEvents";
import { scopeFor } from "../api/scope";
import { useRoomServer } from "./zenScope";

/** Bell glyph: filled when on, outlined with a slash when off. */
export function BellIcon({ on, size = 18 }: { on: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-bell={on ? "on" : "off"}
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" fill="none" />
      {on ? null : <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

/** Load Thread push prefs for these servers while mounted (feature probe
 *  first; a server without `thread-push-v1` is never asked), and refetch on
 *  `notify_prefs_changed` from the server's app-event hub — the active
 *  server's, and an open room's on another server (one carrier per
 *  server, MS25). */
export function useNotifyPrefsLive(serverIds: string[]): void {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const roomId = useRoomServer((s) => s.serverId);
  const tokens = useServersStore((s) => s.tokens);
  const key = serverIds.filter((id) => tokens[id]).join(",");
  useEffect(() => {
    const { load } = useNotifyPrefsStore.getState();
    for (const id of key ? key.split(",") : []) void load(id);
  }, [key]);
  const activeOn = useNotifyPrefsStore(
    (s) => !!activeServerId && s.threadPush[activeServerId] === true
  );
  const roomOn = useNotifyPrefsStore((s) => !!roomId && s.threadPush[roomId] === true);
  useEffect(() => {
    if (!activeServerId || !activeOn) return;
    const h = connectNotifyPrefsEvents(scopeFor(activeServerId), () => {
      void useNotifyPrefsStore.getState().refresh(activeServerId);
    });
    return () => h.stop();
  }, [activeServerId, activeOn]);
  useEffect(() => {
    if (!roomId || !roomOn) return;
    const h = connectNotifyPrefsEvents(scopeFor(roomId), () => {
      void useNotifyPrefsStore.getState().refresh(roomId);
    });
    return () => h.stop();
  }, [roomId, roomOn]);
}
