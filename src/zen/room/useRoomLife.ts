// The open room's life (multi-server S3): what keeps a room on any server
// honest while it is on screen. Mounted by the Zen page while a Thread is
// open; it acts only with the multi-server flag on, so the flag-off app is
// exactly today's.
//
//   - MS24 keep-alive: `projects/activate` on open and on foreground, on the
//     first send after an idle hour, hourly while open and foregrounded;
//     10 min dedupe per (server, project); a restart clears it (MA16).
//   - MS28 foreground: re-check `/boot-status` for the room's server,
//     compare `instanceId` (a restart resyncs that room only, MS13), re-pull
//     the activity snapshot and the Thread; the sockets reopen themselves
//     through the dial queue.
//   - MS27: a lagged / reopened socket on the room's server re-pulls.
//   - MS36 + auto reconnect: a room on any server folds that server's pool
//     entry and its down / reconnect state (`multi/serverHealth`) into ONE
//     banner. Opening the room checks a non-active server (and a down one)
//     at once; the pool loop keeps checking the room's server (5 s / 15 s /
//     30 s while down) and reconnects it when it answers. While it is down
//     the banner says "Reconnecting to {server}…", then "{server} is
//     offline. We'll keep trying · Retry now"; input stays on and sends
//     wait. One action, scoped to that server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { bootInfoFor, noteBootStatus, readBootStatus, type ServerScope } from "../../api/scope";
import { onServerSignal } from "../../api/serverSignals";
import { onAppLifecycle } from "../../lib/appLifecycle";
import { connectServer } from "../../lib/revive";
import { isPairedServer, useServersStore } from "../../stores/servers";
import { useMultiServerPrefs } from "../multi/prefs";
import { pool, usePoolEntries } from "../multi/pool";
import { retryServerNow } from "../multi/poolLoop";
import { retryServerFromUser } from "../multi/recovery";
import { serverDown, useHealth } from "../multi/serverHealth";
import { labelOf } from "../multi/useMultiServerList";
import type { StubAgent } from "../stubData";
import { useZenStore } from "../zenStore";
import { useRoomElsewhere, useZenScope, zenServerId } from "../zenScope";
import { createRoomKeepAlive, resetKeepAlive, roomProjectId, type RoomKeepAlive } from "./keepAlive";
import { roomFailure, type RoomFailure } from "./roomFailure";

let currentKeepAlive: RoomKeepAlive | null = null;

/** A send in the open room (the keep-alive's idle-hour rule). */
export function noteRoomInput(): void {
  currentKeepAlive?.input();
}

/** MS28: the room's server came back to the foreground. Re-check it, and
 *  resync THAT room only when its daemon restarted. Exported for tests. */
export async function roomForeground(scope: ServerScope): Promise<"restarted" | "same" | "offline"> {
  if (!scope.id) return "offline";
  const before = bootInfoFor(scope.id)?.instanceId ?? null;
  const body = await readBootStatus(scope);
  if (zenServerId() !== scope.id) return "same";
  const z = useZenStore.getState();
  if (body === null) return "offline";
  const info = noteBootStatus(scope.id, body);
  const restarted = !!before && !!info.instanceId && before !== info.instanceId;
  if (restarted) {
    resetKeepAlive(scope.id);
    const id = z.agentId;
    await z.hydrateAgents(id ? { resumeId: id } : undefined);
  } else {
    void z.refreshOpenThread();
  }
  void z.refreshActivity();
  return restarted ? "restarted" : "same";
}

export interface RoomLife {
  /** The room is on a server other than the active one. */
  elsewhere: boolean;
  scope: ServerScope;
  label: string;
  failure: RoomFailure | null;
  /** The banner's one action. */
  act: () => void;
  signInOpen: boolean;
  setSignInOpen: (open: boolean) => void;
}

export function useRoomLife(opts: { open: boolean; agent: StubAgent | undefined }): RoomLife {
  const on = useMultiServerPrefs((s) => s.multiServer);
  const scope = useZenScope();
  const elsewhere = useRoomElsewhere();
  const serverId = scope.id;
  const saved = useServersStore((s) => s.servers.some((x) => x.id === serverId));
  const hasLogin = useServersStore((s) => !!s.tokens[serverId]);
  const paired = useServersStore((s) => isPairedServer(s.servers.find((x) => x.id === serverId)));
  const label = useServersStore(
    useShallow((s) => {
      const e = s.servers.find((x) => x.id === serverId);
      return e ? labelOf(e) : scope.label;
    })
  );
  const entries = usePoolEntries();
  const entry = entries[serverId];
  const [signInOpen, setSignInOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = on && opts.open && !!serverId;

  // ── MS36: opening the room checks its server now (a non-active one
  //    always, a down one as the user's own try); the pool loop keeps
  //    checking it while the room is open and reconnects it ──
  useEffect(() => {
    if (!live) return;
    if (serverDown(serverId, pool.entry(serverId))) retryServerFromUser(serverId);
    else if (elsewhere) retryServerNow(serverId);
  }, [live, elsewhere, serverId]);

  const downSince = useHealth((h) => h.downSince[serverId] ?? null);
  const retryAt = useHealth((h) => h.retryAt[serverId] ?? null);
  const reconnecting = useHealth((h) => h.reconnecting[serverId] === true);
  const expired = useHealth((h) => h.expired[serverId] === true);

  // The "Reconnecting…" → "offline" switch ticks once a second while down.
  const failure = useMemo(
    () =>
      live
        ? roomFailure({
            saved,
            hasLogin,
            entry,
            serverLabel: label,
            signingIn: signInOpen,
            now,
            active: !elsewhere,
            downSince,
            retryAt,
            reconnecting,
            expired,
            paired,
          })
        : null,
    [live, elsewhere, saved, hasLogin, entry, label, signInOpen, now, downSince, retryAt, reconnecting, expired, paired]
  );
  const ticking =
    failure?.state === "offline" || failure?.state === "reconnecting" || failure?.state === "restarting";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // ── MS24: keep-alive for the open row's workspace on its server ──
  const serverProjects = useZenStore((s) => s.serverProjects);
  const projectId = live ? roomProjectId(opts.agent, serverProjects) : null;
  useEffect(() => {
    if (!projectId) return;
    const ka = createRoomKeepAlive(scope, projectId);
    currentKeepAlive = ka;
    ka.opened();
    ka.setHot(typeof document === "undefined" || document.visibilityState !== "hidden");
    const stop = onAppLifecycle((phase) => {
      if (phase === "background") ka.setHot(false);
      else {
        ka.setHot(true);
        ka.focused();
      }
    });
    return () => {
      stop();
      ka.dispose();
      if (currentKeepAlive === ka) currentKeepAlive = null;
    };
  }, [scope, projectId]);

  // ── MS28: foreground resync for the room's server only ──
  useEffect(() => {
    if (!live) return;
    return onAppLifecycle((phase) => {
      if (phase !== "foreground") return;
      void roomForeground(scope);
      if (elsewhere) retryServerNow(scope.id);
    });
  }, [live, scope, elsewhere]);

  // ── MS27: a lagged or reopened socket on THIS server re-pulls ──
  const repullAt = useRef(0);
  useEffect(() => {
    if (!live) return;
    return onServerSignal((id, signal) => {
      if (id !== serverId || (signal !== "lagged" && signal !== "reopened")) return;
      // Several sockets reopen together: one re-pull per second.
      const t = Date.now();
      if (t - repullAt.current < 1000) return;
      repullAt.current = t;
      const z = useZenStore.getState();
      void z.refreshActivity();
      void z.refreshOpenThread();
    });
  }, [live, serverId]);

  const act = useCallback(() => {
    const action = failure?.action;
    if (action === "retry") {
      retryServerFromUser(serverId);
    } else if (action === "sign-in") {
      setSignInOpen(true);
    } else if (action === "switch") {
      // MS30: too old for a room — open it the old way (switch active).
      void (async () => {
        const outcome = await connectServer(serverId);
        if (outcome === "still-valid" || outcome === "revived") {
          useServersStore.getState().setActive(serverId);
        } else if (outcome === "signin-required") {
          setSignInOpen(true);
        }
      })();
    }
  }, [failure?.action, serverId]);

  return { elsewhere, scope, label, failure, act, signInOpen, setSignInOpen };
}
