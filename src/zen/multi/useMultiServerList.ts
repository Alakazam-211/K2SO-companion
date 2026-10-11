// Everything the Agents list needs to show rows from every saved server
// (multi-server S2). Off (`zen.multiServer` unset) it does nothing: no pool
// loop, no remote reads, and ChatsList renders exactly as before.
//
// On:
//   - the pool loop runs while the list is on screen (MS11/MS12, MA11);
//   - a healthy other server whose rows are missing or over a minute old
//     is (re)loaded on its own scope; a restart reloads that server only
//     (MS13) — for the active server, its pins, groups and activity;
//   - the filter's server, when it is not the active one, keeps a 5 s
//     activity snapshot (Q7: at most two servers — that one and the
//     default); every other server shows the summary's dot and word;
//   - rows from every server in the filter merge into one list (MS15–MS20).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { hostLabel, serverHostKey, useServersStore, type ServerEntry } from "../../stores/servers";
import { scopeFor, versionAtLeast } from "../../api/scope";
import { connectServer } from "../../lib/revive";
import type { StubAgent } from "../stubData";
import type { FocusState, ServerProject } from "../serverPins";
import { useZenStore } from "../zenStore";
import {
  buildMergedList,
  showServerChips,
  snapshotServerIds,
  type MergedList,
  type MergedSource,
  type ServerFilter,
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

/** How often the filter's (remote) server re-reads its snapshot (Q7). */
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
  filter: ServerFilter;
  setFilter: (f: ServerFilter) => void;
  /** More than one server saved: chips on rows (MS20). */
  chips: boolean;
  /** "All servers" over several servers: the title reads "All servers". */
  mixing: boolean;
  /** The filter's server when it is not the active one. */
  remoteFilterId: string | null;
  merged: MergedList;
  placeholders: Placeholder[];
  byServer: Record<string, RemoteRows>;
  entries: Record<string, PoolEntry>;
  /** Servers in the filter with a load running (MS39). */
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
  const rawFilter = useMultiServerPrefs((s) => s.serverFilter);
  const setFilter = useMultiServerPrefs((s) => s.setServerFilter);
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const tokens = useServersStore(useShallow((s) => s.tokens));
  const entries = usePoolEntries();
  const byServer = useRemoteRows((s) => s.byServer);
  const [signInFor, setSignInFor] = useState<string | null>(null);

  const filter: ServerFilter =
    rawFilter !== "all" && servers.some((s) => s.id === rawFilter) ? rawFilter : "all";
  const chips = showServerChips(servers.length);
  const mixing = on && filter === "all" && servers.length > 1;
  const remoteFilterId = on && filter !== "all" && filter !== activeServerId ? filter : null;
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

  // Q7: the filter's server keeps a 5 s snapshot while the list is up.
  const snapshotIds = useMemo(
    () => (on ? snapshotServerIds({ activeId: activeServerId, filter }) : []),
    [on, activeServerId, filter]
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
    const sources: MergedSource[] = [];
    for (const s of servers) {
      const isActive = s.id === activeServerId;
      if (isActive) {
        if (active.source !== "live") continue;
        sources.push({
          serverId: s.id,
          hostKey: serverHostKey(s),
          label: labelOf(s),
          active: true,
          hasLogin: !!tokens[s.id],
          agents: active.agents,
          serverProjects: active.serverProjects,
          pinnedIds: active.pinnedIds,
          focus: active.focus,
          hiddenAddrs: active.hiddenAddrs,
        });
        continue;
      }
      const r = byServer[s.id];
      if (!r || r.agents.length === 0) continue;
      sources.push({
        serverId: s.id,
        hostKey: serverHostKey(s),
        label: labelOf(s),
        active: false,
        hasLogin: !!tokens[s.id],
        agents: r.agents,
        serverProjects: r.serverProjects,
        pinnedIds: r.pinnedIds,
        focus: r.focus,
        hiddenAddrs: r.hiddenAddrs,
      });
    }
    return buildMergedList(sources, { q: opts.q, filter, chips });
  }, [on, servers, activeServerId, active, byServer, tokens, opts.q, filter, chips]);

  const placeholders = useMemo<Placeholder[]>(() => {
    if (!on) return [];
    const q = opts.q.trim().toLowerCase();
    const out: Placeholder[] = [];
    for (const s of servers) {
      if (filter !== "all" && filter !== s.id) continue;
      const label = labelOf(s);
      if (q && !label.toLowerCase().includes(q)) continue;
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
  }, [on, servers, filter, opts.q, activeServerId, active.source, byServer, statusFor, entries]);

  const loads = useMemo(
    () =>
      on
        ? servers
            .filter((s) => (filter === "all" || filter === s.id) && s.id !== activeServerId)
            .map((s) => ({ serverId: s.id, label: labelOf(s), startedAt: byServer[s.id]?.loadStartedAt ?? null }))
            .filter((l): l is { serverId: string; label: string; startedAt: number } => l.startedAt !== null)
        : [],
    [on, servers, filter, activeServerId, byServer]
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
    filter,
    setFilter,
    chips,
    mixing,
    remoteFilterId,
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
