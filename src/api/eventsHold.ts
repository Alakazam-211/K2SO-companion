// Hold the legacy `/events` WebSocket off one server.
//
// Remote update contract (v0.46.0, Gotchas): a bundled-app daemon decides
// "the K2 desktop app is running" from the `/events` subscriber count. A
// phone subscribed there would make it send the update trigger to nobody
// and the job would sit in `downloading` forever. Zen never opens
// `/events` (it rides `/cli/sessions/events`), but the classic pages do
// (`stores/feedback.ts`, `stores/projectGroups.ts`), so while a
// bundled-app update runs on a server those sockets close and stay closed
// for it, and reopen when the hold is released.

type Listener = (serverId: string, held: boolean) => void;

const held = new Set<string>();
const listeners = new Set<Listener>();

export function eventsHeld(serverId: string | null | undefined): boolean {
  return !!serverId && held.has(serverId);
}

export function holdEvents(serverId: string): void {
  if (!serverId || held.has(serverId)) return;
  held.add(serverId);
  for (const fn of [...listeners]) fn(serverId, true);
}

export function releaseEvents(serverId: string): void {
  if (!held.delete(serverId)) return;
  for (const fn of [...listeners]) fn(serverId, false);
}

export function onEventsHold(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only. */
export function __resetEventsHoldForTests(): void {
  held.clear();
}
