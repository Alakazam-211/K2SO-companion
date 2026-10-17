import { create } from "zustand";
import { serverHasFeature } from "../api/client";
import { scopeFor } from "../api/scope";
import { onServerForget } from "./servers";

// "Show message previews", per saved server (K2 0.46.1 `push-previews-v1`).
// Phone-side pref, keyed by server id (MA2), sent as `previews` on
// `/cli/push/register-device` ONLY when that server's `/boot-status`
// lists the key (an older daemon may reject an unknown field). The
// daemon answers with this device's `previews` and the owner's master
// switch `previewsAllowed`; both are kept here.
//
// Same synchronous localStorage idiom as the other phone prefs: one JSON
// object under `k2.push.previews.v1`, every access in try/catch (a
// failed write lasts the session).

/** `/boot-status` key: register-device takes `previews`. */
export const FEATURE_PUSH_PREVIEWS = "push-previews-v1";
/** `/boot-status` key: register-device takes `environment`. */
export const FEATURE_PUSH_ENVIRONMENT = "push-environment-v1";

export const PUSH_PREVIEWS_KEY = "k2.push.previews.v1";

interface Persisted {
  /** Server id → this device's pref. Absent = default (on). */
  previews: Record<string, boolean>;
  /** Server id → the owner's `previewsAllowed` from the last reply. */
  allowed: Record<string, boolean>;
}

function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
    if (typeof b === "boolean") out[k] = b;
  }
  return out;
}

export function readPushPreviews(): Persisted {
  try {
    const raw = localStorage.getItem(PUSH_PREVIEWS_KEY);
    const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { previews: boolMap(j.previews), allowed: boolMap(j.allowed) };
  } catch {
    return { previews: {}, allowed: {} };
  }
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(PUSH_PREVIEWS_KEY, JSON.stringify(p));
  } catch {
    /* the choice lasts this session */
  }
}

/** What register-device answered about previews (either may be absent). */
export interface RegisterReply {
  previews: boolean | null;
  previewsAllowed: boolean | null;
}

/** Parse a register-device reply body. Anything unreadable → nulls. */
export function parseRegisterReply(raw: unknown): RegisterReply {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      o = null;
    }
  }
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return {
    previews: typeof r.previews === "boolean" ? r.previews : null,
    previewsAllowed: typeof r.previewsAllowed === "boolean" ? r.previewsAllowed : null,
  };
}

interface PushPreviewsState extends Persisted {
  /** Server id → has `push-previews-v1`. Absent = not probed yet. */
  feature: Record<string, boolean>;
  /** Server id → the last toggle's error, cleared by the next toggle. */
  errors: Record<string, string | null>;
  /** Probe the feature (cached boot-status). True when on. */
  probe: (serverId: string) => Promise<boolean>;
  /** Set (and persist) this device's pref for a server. */
  setPref: (serverId: string, on: boolean) => void;
  setError: (serverId: string, error: string | null) => void;
  /** Record a register-device reply. `sent` is the `previews` value the
   *  request carried (undefined when it carried none). */
  noteReply: (serverId: string, sent: boolean | undefined, reply: RegisterReply) => void;
  forget: (serverId: string) => void;
}

export const usePushPreviewsStore = create<PushPreviewsState>((set, get) => {
  const save = () => persist({ previews: get().previews, allowed: get().allowed });
  return {
    ...readPushPreviews(),
    feature: {},
    errors: {},

    probe: async (serverId) => {
      let on = false;
      try {
        on = await serverHasFeature(scopeFor(serverId), FEATURE_PUSH_PREVIEWS);
      } catch {
        on = false;
      }
      if (get().feature[serverId] !== on) {
        set({ feature: { ...get().feature, [serverId]: on } });
      }
      return on;
    },

    setPref: (serverId, on) => {
      set({ previews: { ...get().previews, [serverId]: on } });
      save();
    },

    setError: (serverId, error) => {
      set({ errors: { ...get().errors, [serverId]: error } });
    },

    noteReply: (serverId, sent, reply) => {
      let changed = false;
      if (reply.previewsAllowed !== null && get().allowed[serverId] !== reply.previewsAllowed) {
        set({ allowed: { ...get().allowed, [serverId]: reply.previewsAllowed } });
        changed = true;
      }
      // The server's answer to what we just sent wins.
      if (sent !== undefined && reply.previews !== null && reply.previews !== sent) {
        set({ previews: { ...get().previews, [serverId]: reply.previews } });
        changed = true;
      }
      if (changed) save();
    },

    forget: (serverId) => {
      const { [serverId]: _p, ...previews } = get().previews;
      const { [serverId]: _a, ...allowed } = get().allowed;
      const { [serverId]: _f, ...feature } = get().feature;
      const { [serverId]: _e, ...errors } = get().errors;
      set({ previews, allowed, feature, errors });
      save();
    },
  };
});

// A removed or re-keyed server starts over (MA2).
onServerForget((id) => usePushPreviewsStore.getState().forget(id));

/** This device's pref for a server (default on). */
export function previewsPref(serverId: string): boolean {
  return usePushPreviewsStore.getState().previews[serverId] ?? true;
}
