import { create } from "zustand";
import {
  FEATURE_THREAD_PUSH,
  getNotifyPrefs,
  parseNotifyPrefs,
  serverHasFeature,
  setNotifyPrefs,
  type NotifyPrefs,
  type NotifyPrefsWrite,
  type NotifyWorkspacePref,
} from "../api/client";
import { scopeFor } from "../api/scope";
import { onServerForget } from "./servers";

// Thread push prefs, per saved server (K2 0.45.5 `thread-push-v1`). Keyed
// by server id (MA2); every call runs on `scopeFor(serverId)` (MS32).
//
// GATE: `threadPush[serverId]` mirrors that server's `/boot-status`
// `features[]`. Until it reads true, no bell renders and nothing here
// calls `/cli/notify/*`. Prefs are fetched when the Servers sheet or the
// Sessions drawer opens, and again on `notify_prefs_changed`. Writes are
// optimistic and roll back on any error.

interface NotifyPrefsState {
  /** Server id → has `thread-push-v1`. Absent = not probed yet. */
  threadPush: Record<string, boolean>;
  /** Server id → the caller's prefs there (last good read or write). */
  prefs: Record<string, NotifyPrefs>;
  /** Server id → the last write's error, cleared by the next success. */
  errors: Record<string, string | null>;
  /** Probe the feature only (cached boot-status). True when on. */
  probe: (serverId: string) => Promise<boolean>;
  /** Probe the feature, then fetch prefs when on. */
  load: (serverId: string) => Promise<void>;
  /** Refetch prefs for a server already known to have the feature. */
  refresh: (serverId: string) => Promise<void>;
  setServerEnabled: (serverId: string, enabled: boolean) => Promise<boolean>;
  /** `null` resets the workspace to its default. */
  setWorkspacePush: (
    serverId: string,
    projectId: string,
    threadPush: boolean | null
  ) => Promise<boolean>;
  forget: (serverId: string) => void;
}

/** Same shape the server will answer with, applied ahead of the answer. */
function applyWrite(p: NotifyPrefs, body: NotifyPrefsWrite): NotifyPrefs {
  let next = p;
  if (body.server) {
    next = { ...next, server: { enabled: body.server.enabled, source: "user" } };
  }
  if (body.workspace) {
    const { projectId, threadPush } = body.workspace;
    next = {
      ...next,
      workspaces: next.workspaces.map((w): NotifyWorkspacePref => {
        if (w.projectId !== projectId) return w;
        if (threadPush === null) {
          // The workspace's `*` default is not in the caller's GET; the
          // server's answer corrects this guess a moment later.
          return {
            projectId: w.projectId,
            name: w.name,
            handle: w.handle,
            threadPush: next.default,
            source: "default",
          };
        }
        return {
          ...w,
          threadPush,
          source: "user",
          updatedBy: next.principal || w.updatedBy,
        };
      }),
    };
  }
  return next;
}

export const useNotifyPrefsStore = create<NotifyPrefsState>((set, get) => {
  /** Bumped per server by every write and read, so a slow GET cannot land
   *  over a newer optimistic write. */
  const gens = new Map<string, number>();
  const bumpGen = (id: string) => {
    const g = (gens.get(id) ?? 0) + 1;
    gens.set(id, g);
    return g;
  };

  async function write(serverId: string, body: NotifyPrefsWrite): Promise<boolean> {
    const before = get().prefs[serverId];
    if (!before || !get().threadPush[serverId]) return false;
    const gen = bumpGen(serverId);
    set({
      prefs: { ...get().prefs, [serverId]: applyWrite(before, body) },
      errors: { ...get().errors, [serverId]: null },
    });
    let error: string | null = null;
    let fresh: NotifyPrefs | null = null;
    try {
      const r = await setNotifyPrefs(scopeFor(serverId), body);
      if (r.ok) fresh = parseNotifyPrefs(r.data);
      else error = r.error || "Could not save";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (gens.get(serverId) !== gen) return !error;
    if (error) {
      set({
        prefs: { ...get().prefs, [serverId]: before },
        errors: { ...get().errors, [serverId]: error },
      });
      return false;
    }
    if (fresh) set({ prefs: { ...get().prefs, [serverId]: fresh } });
    return true;
  }

  return {
    threadPush: {},
    prefs: {},
    errors: {},

    probe: async (serverId) => {
      let on = false;
      try {
        on = await serverHasFeature(scopeFor(serverId), FEATURE_THREAD_PUSH);
      } catch {
        on = false;
      }
      if (get().threadPush[serverId] !== on) {
        set({ threadPush: { ...get().threadPush, [serverId]: on } });
      }
      return on;
    },

    load: async (serverId) => {
      if (await get().probe(serverId)) await get().refresh(serverId);
    },

    refresh: async (serverId) => {
      if (!get().threadPush[serverId]) return;
      const gen = bumpGen(serverId);
      try {
        const r = await getNotifyPrefs(scopeFor(serverId));
        if (gens.get(serverId) !== gen || !r.ok) return;
        const p = parseNotifyPrefs(r.data);
        if (p) set({ prefs: { ...get().prefs, [serverId]: p } });
      } catch {
        /* keep the last good read */
      }
    },

    setServerEnabled: (serverId, enabled) => write(serverId, { server: { enabled } }),

    setWorkspacePush: (serverId, projectId, threadPush) =>
      write(serverId, { workspace: { projectId, threadPush } }),

    forget: (serverId) => {
      const { [serverId]: _p, ...prefs } = get().prefs;
      const { [serverId]: _t, ...threadPush } = get().threadPush;
      const { [serverId]: _e, ...errors } = get().errors;
      gens.delete(serverId);
      set({ prefs, threadPush, errors });
    },
  };
});

// A removed or re-keyed server starts over (MA2).
onServerForget((id) => useNotifyPrefsStore.getState().forget(id));

/** True once that server is known to have `thread-push-v1`. */
export function threadPushOn(serverId: string | null | undefined): boolean {
  return !!serverId && useNotifyPrefsStore.getState().threadPush[serverId] === true;
}

// ─── Copy (pure) ───

/** Muted line under a server's name in the Servers sheet. */
export function serverBellStatus(p: NotifyPrefs): string {
  if (p.push === "airgap") return "Off: air-gap";
  if (!p.server.enabled) return "Notifications off";
  if (p.push === "dormant") return "Can't send pushes yet";
  return "Notifications on";
}

/** Where a workspace's Thread push setting comes from. */
export function workspaceSourceText(w: NotifyWorkspacePref, principal: string): string {
  if (w.source === "user") {
    const by = (w.updatedBy || "").trim();
    return by && by !== principal ? `Set by ${by}` : "Set by you";
  }
  return `Default (${w.threadPush ? "on" : "off"})`;
}

/** The prefs row for a chat's workspace: by handle (`k2/reviewer` → `k2`),
 *  then by project id. Never guesses. */
export function workspacePrefFor(
  p: NotifyPrefs | undefined,
  match: { handle?: string | null; projectId?: string | null }
): NotifyWorkspacePref | null {
  if (!p) return null;
  const handle = (match.handle || "").trim().split("/")[0];
  if (handle) {
    const hit = p.workspaces.find((w) => w.handle === handle);
    if (hit) return hit;
  }
  const pid = (match.projectId || "").trim();
  if (pid) return p.workspaces.find((w) => w.projectId === pid) ?? null;
  return null;
}
