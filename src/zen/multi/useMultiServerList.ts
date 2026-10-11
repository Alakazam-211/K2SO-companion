// Everything the Agents list needs to show rows from every saved server
// (multi-server S2). Off (`zen.multiServer` = "0") it does nothing: no pool
// loop, no remote reads, and ChatsList renders exactly as before.
//
// On:
//   - the pool loop runs while the list is on screen (MS11/MS12, MA11);
//   - a healthy other server whose rows are missing or over a minute old
//     is (re)loaded on its own scope; a restart reloads that server only
//     (MS13) — for the active server, its pins, groups and activity;
//   - the Agents tab is always ONE server (the pill's pick, else the
//     active/default server); that server, when it is not the active one,
//     keeps a 5 s activity snapshot (Q7: at most two servers — that one
//     and the default); every other server shows the summary's dot and
//     word (Home rows, the pill menu);
//   - the list (rows, pins, placeholder, search) is that server's only.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { hostLabel, serverHostKey, useServersStore, type ServerEntry } from "../../stores/servers";
import { scopeFor, versionAtLeast } from "../../api/scope";
import { connectServer } from "../../lib/revive";
import type { StubAgent } from "../stubData";
import type { FocusState, ServerProject } from "../serverPins";
import { useZenStore } from "../zenStore";
import {
  buildServerList,
  showServerChips,
  snapshotServerIds,
  type MergedList,
  type MergedSource,
} from "./merge";
import { pool, roleAllowsRoom, usePoolEntries, type PoolEntry } from "./pool";
import { retryServerNow, usePoolLoop } from "./poolLoop";
import { useMultiServerPrefs } from "./prefs";
import {
  clearServerSnapshot,
  loadServerRows,
  refreshServerSnapshot,
  rowsStale,
  useRemoteRows,
  type RemoteRows,
} from "./remoteRows";
import {
  PHONE_FLOOR,
  resolveRowStatus,
  rowFailure,
  serverBadge,
  type FailureAction,
  type RowFailure,
  type RowStatus,
} from "./rowStatus";

/** How often the Agents tab's (remote) server re-reads its snapshot (Q7). */
export const REMOTE_SNAPSHOT_MS = 5_000;

export const labelOf = (s: Pick<ServerEntry, "nickname" | "url">) => s.nickname || hostLabel(s.url);

/** Live, signed in, allowed, and at or above the phone's floor: only
 *  then are its lists read. */
function healthy(e: PoolEntry | undefined): boolean {
  if (!e || e.reach !== "live" || e.auth !== "ok" || !roleAllowsRoom(e.role)) return false;
  const v = e.boot?.version ?? null;
  return !v || versionAtLeast(v, PHONE_FLOOR);
}

export interface ActiveSlice {
  source: "stub" | "live" | "error" | "loading";
  agents: StubAgent[];
  serverProjects: ServerProject[];
  pinnedIds: string[];
  focus: FocusState;
  hiddenAddrs: string[];
}

export interface Placeholder {
  serverId: string;
  label: string;
  failure: RowFailure | null;
  note: string;
  nextAt: number | null;
}

export interface MultiServerList {
  on: boolean;
  /** The Agents tab's server: the pill's saved pick, else the active
   *  (default) server. Null only with no servers saved. */
  selectedId: string | null;
  /** Remember the Agents tab's server on this device. */
  setSelected: (serverId: string) => void;
  /** More than one server saved: chips on Home rows (MS20). */
  chips: boolean;
  /** The Agents tab's server when it is not the active one. */
  remoteSelectedId: string | null;
  merged: MergedList;
  placeholders: Placeholder[];
  byServer: Record<string, RemoteRows>;
  entries: Record<string, PoolEntry>;
  /** The Agents tab's server, while its load runs (MS39). */
  loads: { serverId: string; label: string; startedAt: number }[];
  /** Servers keeping the 5 s snapshot (Q7). */
  snapshotIds: string[];
  labelFor: (serverId: string) => string;
  /** The fold for one row of a non-active server. */
  statusFor: (serverId: string, workspaceId: string | null, roomActivity?: RowStatus["kind"] | null) => RowStatus;
  failureFor: (serverId: string, status: RowStatus) => RowFailure | null;
  badgeFor: (serverId: string) => { color: string; word: string };
  signInFor: string | null;
  setSignInFor: (id: string | null) => void;
  /** MS21: open a row from any server in a ROOM on that server; the
   *  active server never changes. Below the phone floor (MS30, Q9) it
   *  opens the old way instead (switch the active server). */
  openOnServer: (serverId: string, localId: string | null) => Promise<void>;
  /** "Open the old way": switch the active server, then open there. */
  switchOpen: (serverId: string, localId: string | null) => Promise<void>;
  /** A failure row's one action, scoped to its server. */
  act: (serverId: string, action: FailureAction) => void;
}

export function useMultiServerList(opts: {
  q: string;
  listOnScreen: boolean;
  active: ActiveSlice;
}): MultiServerList {
  const on = useMultiServerPrefs((s) => s.multiServer);
  const picked = useMultiServerPrefs((s) => s.serverFilter);
  const setServerFilter = useMultiServerPrefs((s) => s.setServerFilter);
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const tokens = useServersStore(useShallow((s) => s.tokens));
  const entries = usePoolEntries();
  const byServer = useRemoteRows((s) => s.byServer);
  const [signInFor, setSignInFor] = useState<string | null>(null);

  const saved = (id: string | null) => !!id && servers.some((s) => s.id === id);
  const selectedId: string | null = saved(picked)
    ? picked
    : saved(activeServerId)
      ? activeServerId
      : servers[0]?.id ?? null;
  const setSelected = useCallback((id: string) => setServerFilter(id), [setServerFilter]);
  const chips = showServerChips(servers.length);
  const remoteSelectedId = on && selectedId !== activeServerId ? selectedId : null;
  const ids = useMemo(() => servers.map((s) => s.id), [servers]);

  const onChecked = useCallback(
    (id: string, e: PoolEntry | undefined) => {
      if (id === activeServerId || !healthy(e)) return;
      if (rowsStale(useRemoteRows.getState().byServer[id], Date.now())) void loadServerRows(id);
    },
    [activeServerId]
  );
  usePoolLoop(on && opts.listOnScreen, ids, activeServerId, onChecked);

  // MS13: a restart resyncs THAT server only.
  useEffect(() => {
    if (!on) return;
    return pool.onRestart((id) => {
      if (id === useServersStore.getState().activeServerId) {
        const z = useZenStore.getState();
        z.refreshServerLists();
        void z.refreshActivity();
      } else {
        void loadServerRows(id);
      }
    });
  }, [on]);

  // Q7: the Agents tab's server keeps a 5 s snapshot while the list is up.
  const snapshotIds = useMemo(
    () => (on ? snapshotServerIds({ activeId: activeServerId, selectedId }) : []),
    [on, activeServerId, selectedId]
  );
  const remoteSnapshotId = snapshotIds.find((id) => id !== activeServerId) ?? null;
  useEffect(() => {
    if (!remoteSnapshotId || !opts.listOnScreen) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (document.visibilityState !== "hidden" && healthy(pool.entry(remoteSnapshotId))) {
        void refreshServerSnapshot(remoteSnapshotId);
      }
      timer = setTimeout(tick, REMOTE_SNAPSHOT_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
      clearServerSnapshot(remoteSnapshotId);
    };
  }, [remoteSnapshotId, opts.listOnScreen]);

  const labelFor = useCallback(
    (id: string) => {
      const s = servers.find((x) => x.id === id);
      return s ? labelOf(s) : id;
    },
    [servers]
  );

  const statusFor = useCallback(
    (id: string, workspaceId: string | null, roomActivity?: RowStatus["kind"] | null) =>
      resolveRowStatus({
        saved: servers.some((s) => s.id === id),
        hasLogin: !!tokens[id],
        entry: entries[id],
        serverLabel: labelFor(id),
        signingIn: signInFor === id,
        workspaceId,
        roomActivity:
          roomActivity === "working" ||
          roomActivity === "permission" ||
          roomActivity === "monitoring" ||
          roomActivity === "idle"
            ? roomActivity
            : null,
      }),
    [servers, tokens, entries, labelFor, signInFor]
  );

  const failureFor = useCallback(
    (id: string, status: RowStatus) => rowFailure(status, entries[id], labelFor(id), Date.now()),
    [entries, labelFor]
  );

  const badgeFor = useCallback(
    (id: string) =>
      serverBadge({
        saved: servers.some((s) => s.id === id),
        hasLogin: !!tokens[id],
        entry: entries[id],
        serverLabel: labelFor(id),
        signingIn: signInFor === id,
      }),
    [servers, tokens, entries, labelFor, signInFor]
  );

  const { active } = opts;
  const merged = useMemo<MergedList>(() => {
    if (!on) return { rows: [], pinned: [] };
    const s = servers.find((x) => x.id === selectedId);
    if (!s) return { rows: [], pinned: [] };
    let src: MergedSource | null = null;
    if (s.id === activeServerId) {
      if (active.source === "live") {
        src = {
          serverId: s.id,
          hostKey: serverHostKey(s),
          label: labelOf(s),
          active: true,
          agents: active.agents,
          serverProjects: active.serverProjects,
          pinnedIds: active.pinnedIds,
          focus: active.focus,
          hiddenAddrs: active.hiddenAddrs,
        };
      }
    } else {
      const r = byServer[s.id];
      if (r && r.agents.length > 0) {
        src = {
          serverId: s.id,
          hostKey: serverHostKey(s),
          label: labelOf(s),
          active: false,
          agents: r.agents,
          serverProjects: r.serverProjects,
          pinnedIds: r.pinnedIds,
          focus: r.focus,
          hiddenAddrs: r.hiddenAddrs,
        };
      }
    }
    return buildServerList(src, { q: opts.q });
  }, [on, servers, selectedId, activeServerId, active, byServer, opts.q]);

  const placeholders = useMemo<Placeholder[]>(() => {
    if (!on) return [];
    const out: Placeholder[] = [];
    for (const s of servers) {
      if (s.id !== selectedId) continue;
      const label = labelOf(s);
      if (s.id === activeServerId) {
        // The active server keeps today's paths; only "signed out" (the
        // stub list) needs a row here.
        if (active.source !== "stub") continue;
        out.push({
          serverId: s.id,
          label,
          failure: {
            state: "signin-required",
            copy: `Sign in to ${label}`,
            action: "sign-in",
            actionLabel: "Sign in",
          },
          note: "",
          nextAt: null,
        });
        continue;
      }
      const r = byServer[s.id];
      if (r && r.agents.length > 0) continue;
      const status = statusFor(s.id, null);
      const failure = rowFailure(status, entries[s.id], label, Date.now());
      out.push({
        serverId: s.id,
        label,
        failure,
        note: !r || r.loadedAt === null ? (r?.status === "error" ? r.error || "Could not load" : "Loading…") : "No agents",
        nextAt: entries[s.id]?.nextAt ?? null,
      });
    }
    return out;
  }, [on, servers, selectedId, activeServerId, active.source, byServer, statusFor, entries]);

  const loads = useMemo(
    () =>
      on
        ? servers
            .filter((s) => s.id === selectedId && s.id !== activeServerId)
            .map((s) => ({ serverId: s.id, label: labelOf(s), startedAt: byServer[s.id]?.loadStartedAt ?? null }))
            .filter((l): l is { serverId: string; label: string; startedAt: number } => l.startedAt !== null)
        : [],
    [on, servers, selectedId, activeServerId, byServer]
  );

  const switchOpen = useCallback(async (serverId: string, localId: string | null) => {
    // The old way (MS30 below the floor, or the user's own "Open"):
    // switch the active server, then open the row there.
    const outcome = await connectServer(serverId);
    if (outcome === "still-valid" || outcome === "revived") {
      useServersStore.getState().setActive(serverId);
      await useZenStore.getState().hydrateAgents(localId ? { resumeId: localId } : undefined);
      return;
    }
    if (outcome === "signin-required") setSignInFor(serverId);
  }, []);

  const openOnServer = useCallback(
    async (serverId: string, localId: string | null) => {
      if (roomBelowFloor(serverId)) {
        await switchOpen(serverId, localId);
        return;
      }
      // MS21: a room on that server; the active server stays as it is.
      await useZenStore.getState().openRoom(serverId, {
        id: localId,
        seed: useRemoteRows.getState().byServer[serverId]?.agents,
      });
    },
    [switchOpen]
  );

  const act = useCallback(
    (serverId: string, action: FailureAction) => {
      if (action === "retry") retryServerNow(serverId);
      else if (action === "sign-in") setSignInFor(serverId);
      else void switchOpen(serverId, null);
    },
    [switchOpen]
  );

  return {
    on,
    selectedId,
    setSelected,
    chips,
    remoteSelectedId,
    merged,
    placeholders,
    byServer,
    entries,
    loads,
    snapshotIds,
    labelFor,
    statusFor,
    failureFor,
    badgeFor,
    signInFor,
    setSignInFor,
    openOnServer,
    switchOpen,
    act,
  };
}

/** MS30 as amended by MA25 / §13 Q9: a KNOWN version below 0.41.6 cannot
 *  hold a Thread room. Unknown (never checked) opens, and checks later. */
export function roomBelowFloor(serverId: string): boolean {
  const v = pool.entry(serverId)?.boot?.version ?? scopeFor(serverId).version();
  return !!v && !versionAtLeast(v, PHONE_FLOOR);
}

/** Is this server's scope able to serve a 5 s snapshot? */
export function snapshotCapable(serverId: string): boolean {
  return scopeFor(serverId).supports("daemon-activity");
}
