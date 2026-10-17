import { create } from "zustand";
import { getProjects } from "../api/client";
import { activeScope, scopeFor } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { revive } from "../lib/revive";
import { eventsHeld, onEventsHold } from "../api/eventsHold";
import { connectTicketEvents, type TicketEventsHandle } from "../zen/ticketEvents";
import {
  fetchAllFeedback,
  fetchFeedbackShow,
  countWaiting,
  feedbackEventTargets,
  type FeedbackBrief,
  type FeedbackListRow,
  type FeedbackShow,
} from "../api/feedback";

// Feedback C3 — items for the ACTIVE server + the open thread + the live
// subscription that keeps both (and the TabBar waiting badge) fresh.
// Tickets stay on the default (active) server in v1 (NG6): every action
// captures `activeScope()` ONCE and uses it for the whole call.
//
// Two live transports (MA9):
//   - Zen (`ensureLive({ via: "hub" })`): the server's ONE shared app socket
//     `/cli/sessions/events?path=` (`zen/ticketEvents.ts`), the same socket
//     the Agents list holds for `projects_changed`. No `/events` in Zen, so
//     a ticket change refetches once, not twice.
//   - Classic pages (default): the legacy `/events` socket below.
//
// The events WS is THIS store's own subscription (no shared events
// module): `<base>/events?token=` (WebSocket cannot set Authorization;
// HTTP /cli uses Bearer) broadcasts `{"event":"feedback:*",
// "payload":{id, projectPath, ...}}` frames (events.rs WireEvent).
// Reconnects consult the C1 revive path BEFORE reopening — a WS close
// after a daemon restart is a stale-token kick indistinguishable from a
// network drop, and looping on a dead token was the exact stranding bug
// (gridSocket.ts idiom). Bursts coalesce on trailing 300ms windows: N
// rapid events fire ONE list refetch and ONE open-thread refetch; only
// `openItem` is replaced by the refetch — the composer's draft lives in
// page state, so mid-typed text survives (draft-protected).
//
// Briefs: `show?brief=1` carries up to 1 MiB of HTML + inline images and
// never changes after filing, so it is fetched ONCE per ticket (on open,
// when the row says `hasBrief`) and kept in memory keyed by ticket id →
// sha256. Every refetch after that is a plain `show`.

/** The brief for one ticket: in flight, loaded (null = the ticket has
 *  none), or failed (the view falls back to `body`). */
export type BriefEntry =
  | { state: "loading" }
  | { state: "ready"; brief: FeedbackBrief | null }
  | { state: "error"; error: string };

interface FeedbackState {
  /** All rows for the ACTIVE server (every status; sectioned in the page). */
  rows: FeedbackListRow[];
  /** Waiting-item count for the TabBar badge (recomputed with rows). */
  waitingCount: number;
  isLoading: boolean;
  error: string | null;
  /** Which server `rows` belong to — a switch refetches from zero. */
  loadedForServer: string | null;

  /** The open thread (`/feedback/:id`). */
  openId: string | null;
  openItem: FeedbackShow | null;
  openError: string | null;
  /** Ticket id → its brief (see BriefEntry). In memory for the session. */
  briefs: Record<string, BriefEntry>;

  /** Idempotent per-server kick: first load + live events for the active
   *  server. Called from the TabBar badge and the pages on server switch.
   *  `via: "hub"` (Zen) rides the shared sessions/events socket instead of
   *  the legacy `/events` one (MA9). */
  ensureLive: (opts?: { via?: "events" | "hub" }) => void;
  refresh: () => Promise<void>;
  /** `withBrief`: the row says `hasBrief`, so the first `show` asks for
   *  `brief=1` too (skipped when the brief is already cached). */
  openThread: (id: string, opts?: { withBrief?: boolean }) => Promise<void>;
  refetchOpen: () => Promise<void>;
  /** Fetch `show?brief=1` once for `id` (no-op when cached or in flight). */
  loadBrief: (id: string) => Promise<void>;
  closeThread: () => void;
}

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  rows: [],
  waitingCount: 0,
  isLoading: false,
  error: null,
  loadedForServer: null,
  openId: null,
  openItem: null,
  openError: null,
  briefs: {},

  ensureLive: (opts) => {
    const scope = activeScope();
    const serverId = scope.id;
    if (!serverId) return;
    if (get().loadedForServer !== serverId) {
      // Server switch: drop the old server's rows immediately (no stale
      // badge/cards from the previous host) and refetch.
      set({ rows: [], waitingCount: 0, error: null, loadedForServer: serverId });
    }
    // Always refetch. A remount (Back from terminal, reopen Chats) used
    // to skip when loadedForServer already matched, so a desktop resolve
    // that missed /events left the waiting badge stuck.
    void get().refresh();
    if (opts?.via === "hub") {
      events.stop();
      hubLive.ensure(serverId);
    } else {
      hubLive.stop();
      events.ensure(serverId);
    }
  },

  refresh: async () => {
    const scope = activeScope();
    const serverId = scope.id;
    if (!serverId) {
      set({ rows: [], waitingCount: 0, error: null, loadedForServer: null });
      return;
    }
    set({ isLoading: true });
    try {
      // Workspaces come from the already-loaded workspaces store
      // (AppLayout refreshes it on every server switch) — never a
      // render-path project fetch; the one fallback covers a cold
      // deep-link before that load lands.
      let projects = useWorkspacesStore.getState().projects;
      if (projects.length === 0) {
        const r = await getProjects(scope);
        if (r.ok && r.data) projects = r.data;
        else throw new Error(r.error || "Failed to load workspaces");
      }
      const rows = await fetchAllFeedback(
        scope,
        projects.map((p) => ({ name: p.name, path: p.path }))
      );
      // A switch while loading: these rows belong to the old server.
      if (useServersStore.getState().activeServerId !== serverId) {
        set({ isLoading: false });
        return;
      }
      set({
        rows,
        waitingCount: countWaiting(rows),
        error: null,
        loadedForServer: serverId,
        isLoading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isLoading: false,
      });
    }
  },

  openThread: async (id, opts = {}) => {
    const wantBrief = opts.withBrief === true && briefMissing(get().briefs[id]);
    set({ openId: id, openItem: null, openError: null });
    if (wantBrief) setBrief(id, { state: "loading" });
    const scope = activeScope();
    try {
      const shown = await fetchFeedbackShow(scope, id, { brief: wantBrief });
      if (wantBrief) setBrief(id, { state: "ready", brief: shown.brief ?? null });
      if (get().openId !== id) return; // navigated away mid-fetch
      set({ openItem: withoutBrief(shown), openError: null });
    } catch (err) {
      if (wantBrief) setBrief(id, { state: "error", error: errText(err) });
      if (get().openId !== id) return;
      set({ openError: errText(err) });
    }
  },

  loadBrief: async (id) => {
    if (!briefMissing(get().briefs[id])) return;
    setBrief(id, { state: "loading" });
    const scope = activeScope();
    try {
      const shown = await fetchFeedbackShow(scope, id, { brief: true });
      setBrief(id, { state: "ready", brief: shown.brief ?? null });
    } catch (err) {
      setBrief(id, { state: "error", error: errText(err) });
    }
  },

  refetchOpen: async () => {
    const id = get().openId;
    if (!id) return;
    const scope = activeScope();
    try {
      const item = await fetchFeedbackShow(scope, id);
      if (get().openId !== id) return;
      set({ openItem: withoutBrief(item), openError: null });
    } catch {
      /* keep the last good thread — the next event/mutation retries */
    }
  },

  closeThread: () => set({ openId: null, openItem: null, openError: null }),
}));

// ─── Brief cache ───

/** sha256 → brief. Briefs are immutable, so two loads of the same sha
 *  share one object (and the view's srcdoc memo keys on the sha). */
const briefBySha = new Map<string, FeedbackBrief>();

/** Not cached and not in flight. A failed load retries on the next open. */
function briefMissing(entry: BriefEntry | undefined): boolean {
  return !entry || entry.state === "error";
}

function setBrief(id: string, entry: BriefEntry): void {
  let next = entry;
  if (entry.state === "ready" && entry.brief?.sha256) {
    const cached = briefBySha.get(entry.brief.sha256);
    if (cached) next = { state: "ready", brief: cached };
    else briefBySha.set(entry.brief.sha256, entry.brief);
  }
  useFeedbackStore.setState((s) => ({ briefs: { ...s.briefs, [id]: next } }));
}

/** The open item never holds the brief HTML (it lives in `briefs`). */
function withoutBrief(item: FeedbackShow): FeedbackShow {
  if (!("brief" in item)) return item;
  const { brief: _brief, ...rest } = item;
  return rest;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Coalesced refetch timers (trailing 300ms; bursts → one fetch) ───

let listTimer: ReturnType<typeof setTimeout> | null = null;
let threadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleListRefresh(): void {
  if (listTimer) clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    listTimer = null;
    void useFeedbackStore.getState().refresh();
  }, 300);
}

function scheduleThreadRefetch(): void {
  if (threadTimer) clearTimeout(threadTimer);
  threadTimer = setTimeout(() => {
    threadTimer = null;
    void useFeedbackStore.getState().refetchOpen();
  }, 300);
}

// ─── /events WS (feedback-filtered; revive-gated reconnect) ───

interface WireEvent {
  event: string;
  payload?: { id?: string };
}

class FeedbackEventsSocket {
  private ws: WebSocket | null = null;
  private serverId: string | null = null;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Connect for `serverId` if not already live against it. A server
   *  switch tears the old stream down first; a socket parked by an
   *  earlier `signin-required` gets a fresh start (the user just
   *  reconnected via the Servers page). */
  ensure(serverId: string): void {
    if (
      this.serverId === serverId &&
      (this.isOpenOrConnecting || this.reconnectTimer !== null)
    ) {
      return;
    }
    this.teardown();
    this.serverId = serverId;
    this.shouldReconnect = true;
    this.open();
  }

  private get isOpenOrConnecting(): boolean {
    return (
      this.shouldReconnect &&
      (this.ws?.readyState === WebSocket.OPEN ||
        this.ws?.readyState === WebSocket.CONNECTING)
    );
  }

  /** URL is built FRESH each open so a token revived between attempts is
   *  picked up (the daemon kicks stale tokens off the WS within ~5s). */
  private buildUrl(): string | null {
    const active = useServersStore.getState().activeServerId;
    if (!this.serverId || active !== this.serverId) return null;
    // A bundled-app update is running there (`api/eventsHold.ts`).
    if (eventsHeld(this.serverId)) return null;
    let base: string;
    let token: string;
    try {
      const scope = scopeFor(this.serverId);
      base = scope.wsBase();
      token = scope.token();
    } catch {
      return null; // removed
    }
    if (!base || !token) return null;
    return `${base}/events?token=${encodeURIComponent(token)}`;
  }

  private open(): void {
    const url = this.buildUrl();
    if (!url) {
      // No active server / server switched away — stop, don't spin.
      this.shouldReconnect = false;
      return;
    }
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onmessage = (e) => {
      let frame: WireEvent;
      try {
        frame = JSON.parse(e.data as string) as WireEvent;
      } catch {
        return; // non-JSON frame — ignore
      }
      this.handleEvent(frame);
    };
    this.ws.onclose = () => {
      if (this.shouldReconnect) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  /** Only `feedback:*` frames matter here; everything else on the shared
   *  broadcast (agent:lifecycle, project-group:*, …) is dropped. */
  private handleEvent(frame: WireEvent): void {
    const targets = feedbackEventTargets(frame.event);
    if (!targets) return;
    if (targets.list) scheduleListRefresh();
    if (targets.thread) {
      const openId = useFeedbackStore.getState().openId;
      if (openId && frame.payload?.id === openId) scheduleThreadRefetch();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) void this.reviveThenReopen();
    }, 2000);
  }

  /** Consult the revive path BEFORE re-opening — never loop on a dead
   *  token (gridSocket.ts idiom). `signin-required` parks the socket;
   *  the next `ensure()` (Servers-page reconnect / server switch)
   *  restarts it. unreachable/cooldown reopen and land back here. */
  private async reviveThenReopen(): Promise<void> {
    if (this.serverId) {
      const outcome = await revive(scopeFor(this.serverId), { background: true });
      if (!this.shouldReconnect) return;
      if (outcome === "signin-required" || outcome === "not-applicable") {
        this.shouldReconnect = false;
        return;
      }
    }
    if (this.shouldReconnect) this.open();
  }

  /** The server this socket streams from (null when stopped). */
  get target(): string | null {
    return this.serverId;
  }

  /** Close for good (Zen moved to the shared hub). */
  stop(): void {
    this.teardown();
    this.serverId = null;
  }

  private teardown(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

const events = new FeedbackEventsSocket();

// Remote update on a bundled-app host: off `/events` until it ends, then
// back on (only if this socket was live for that server).
let heldTarget: string | null = null;
onEventsHold((serverId, held) => {
  if (held) {
    if (events.target === serverId) {
      events.stop();
      heldTarget = serverId;
    }
  } else if (heldTarget === serverId) {
    heldTarget = null;
    if (events.target === null) events.ensure(serverId);
  }
});

// ─── Zen: the shared sessions/events hub (MA9) ───

/** One hub subscription for the store, on the active server. Ticket frames
 *  carry ids only: refetch the list and the open thread (debounced). */
const hubLive = {
  serverId: null as string | null,
  handle: null as TicketEventsHandle | null,
  ensure(serverId: string): void {
    // Subscribe the new one BEFORE dropping the old: on the same server the
    // shared socket keeps its other subscribers and never redials. A
    // not-connected server returns a no-op handle; the next ensure retries.
    const prev = this.handle;
    this.serverId = serverId;
    this.handle = connectTicketEvents(scopeFor(serverId), () => {
      scheduleListRefresh();
      scheduleThreadRefetch();
    });
    prev?.stop();
  },
  stop(): void {
    this.handle?.stop();
    this.handle = null;
    this.serverId = null;
  },
};
