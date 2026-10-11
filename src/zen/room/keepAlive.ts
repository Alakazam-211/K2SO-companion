// Room keep-alive (multi-server MS24 as amended by MA16). A port of desktop
// K2's `lib/room-keep-alive.ts` plus the pool's `keepRoomAlive` dedupe.
//
// A workspace on a server ages out on its need clock; a viewer does not
// spare it, only `POST /cli/projects/activate {projectId}` does. A room
// reports need to ITS server (its own scope and login):
//
//   - when the room opens, and when it gets focus again (foreground);
//   - on the first input after an hour with none (every input resets it);
//   - once an hour while the room is open AND the app is in the foreground.
//
// At most one send per (server, project) per 10 min, single-flight; the
// daemon broadcasts `active_changed` to every desktop on each call, so the
// dedupe matters. A server restart (`instanceId` change) clears that
// server's dedupe: the new process has heard nothing. The project id is
// checked against that server's `projects/list` first (the daemon says
// `{ok:true}` even for an unknown id).

import { activateProject } from "../../api/client";
import type { ServerScope } from "../../api/scope";
import type { ServerProject } from "../serverPins";
import { onServerForget } from "../../stores/servers";
import type { StubAgent } from "../stubData";
import { mainHandleOf } from "../sessionDrawer";
import { mainAtPath } from "../serverPins";

export const KEEP_ALIVE_DEDUPE_MS = 10 * 60_000;
export const KEEP_ALIVE_IDLE_MS = 60 * 60_000;
export const KEEP_ALIVE_HOT_INTERVAL_MS = 60 * 60_000;

export type KeepAliveResult = "sent" | "deduped" | "failed";

const sentAt = new Map<string, number>();
const inflight = new Map<string, Promise<KeepAliveResult>>();
let now: () => number = () => Date.now();

const keyOf = (serverId: string, projectId: string) => `${serverId}|${projectId}`;

/** One activate on `scope`'s server, deduped per (server, project). Never
 *  throws. */
export function keepRoomAlive(scope: ServerScope, projectId: string): Promise<KeepAliveResult> {
  if (!scope.id || !projectId) return Promise.resolve("failed");
  const key = keyOf(scope.id, projectId);
  const running = inflight.get(key);
  if (running) return running.then((r) => (r === "sent" ? "deduped" : r));
  const last = sentAt.get(key);
  if (last !== undefined && now() - last < KEEP_ALIVE_DEDUPE_MS) return Promise.resolve("deduped");
  const p = activateProject(scope, projectId)
    .then((r): KeepAliveResult => {
      if (!r.ok) return "failed";
      sentAt.set(key, now());
      return "sent";
    })
    .catch((): KeepAliveResult => "failed")
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** A restart (or removal) of that server: forget what it heard. */
export function resetKeepAlive(serverId: string): void {
  const prefix = `${serverId}|`;
  for (const k of [...sentAt.keys()]) if (k.startsWith(prefix)) sentAt.delete(k);
}

onServerForget((id) => resetKeepAlive(id));

/** The workspace (project) id a room row belongs to on its server: by the
 *  main handle (`k2/reviewer` → `k2`), else the one main project at the
 *  row's path. Only an id `projects/list` lists counts (MA16). */
export function roomProjectId(
  row: Pick<StubAgent, "kind" | "addr" | "path"> | null | undefined,
  projects: ServerProject[]
): string | null {
  if (!row || row.kind === "group") return null;
  const handle = mainHandleOf(row.addr);
  if (handle) {
    const hit = projects.find((p) => p.handle === handle);
    if (hit) return hit.id;
  }
  return mainAtPath(row.path ?? undefined, projects)?.id ?? null;
}

export interface RoomKeepAlive {
  opened(): void;
  focused(): void;
  /** A send or a key in the room: sends only after an idle hour. */
  input(): void;
  /** Open and foregrounded: hourly re-sends; otherwise none. */
  setHot(hot: boolean): void;
  dispose(): void;
}

/** One room's keep-alive (desktop `createRoomKeepAlive`). */
export function createRoomKeepAlive(scope: ServerScope, projectId: string): RoomKeepAlive {
  let last = now();
  let interval: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const send = () => {
    if (disposed) return;
    last = now();
    void keepRoomAlive(scope, projectId);
  };
  const stopInterval = () => {
    if (interval) clearInterval(interval);
    interval = null;
  };
  return {
    opened: send,
    focused: send,
    input() {
      if (disposed) return;
      if (now() - last < KEEP_ALIVE_IDLE_MS) {
        last = now();
        return;
      }
      send();
    },
    setHot(hot) {
      if (disposed) return;
      if (!hot) {
        stopInterval();
        return;
      }
      if (interval) return;
      interval = setInterval(send, KEEP_ALIVE_HOT_INTERVAL_MS);
    },
    dispose() {
      disposed = true;
      stopInterval();
    },
  };
}

/** Tests only. */
export function __resetKeepAliveForTests(clock?: () => number): void {
  sentAt.clear();
  inflight.clear();
  now = clock ?? (() => Date.now());
}
