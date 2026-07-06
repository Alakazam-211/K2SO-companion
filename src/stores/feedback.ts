import { create } from "zustand";
import { getBaseUrl, getToken, getProjects } from "../api/client";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { reviveServerSession } from "../lib/revive";
import {
  fetchAllFeedback,
  fetchFeedbackShow,
  countWaiting,
  feedbackEventTargets,
  type FeedbackListRow,
  type FeedbackShow,
} from "../api/feedback";

// Feedback C3 — items for the ACTIVE server + the open thread + the live
// `/events` subscription that keeps both (and the TabBar waiting badge)
// fresh.
//
// The events WS is THIS store's own subscription (no shared events
// module): `<base>/events?token=` broadcasts `{"event":"feedback:*",
// "payload":{id, projectPath, ...}}` frames (events.rs WireEvent).
// Reconnects consult the C1 revive path BEFORE reopening — a WS close
// after a daemon restart is a stale-token kick indistinguishable from a
// network drop, and looping on a dead token was the exact stranding bug
// (gridSocket.ts idiom). Bursts coalesce on trailing 300ms windows: N
// rapid events fire ONE list refetch and ONE open-thread refetch; only
// `openItem` is replaced by the refetch — the composer's draft lives in
// page state, so mid-typed text survives (draft-protected).

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

  /** Idempotent per-server kick: first load + events WS for the active
   *  server. Called from the TabBar badge and the pages on server switch. */
  ensureLive: () => void;
  refresh: () => Promise<void>;
  openThread: (id: string) => Promise<void>;
  refetchOpen: () => Promise<void>;
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

  ensureLive: () => {
    const serverId = useServersStore.getState().activeServerId;
    if (!serverId) return;
    if (get().loadedForServer !== serverId) {
      // Server switch: drop the old server's rows immediately (no stale
      // badge/cards from the previous host) and refetch.
      set({ rows: [], waitingCount: 0, error: null, loadedForServer: serverId });
      void get().refresh();
    }
    events.ensure(serverId);
  },

  refresh: async () => {
    const serverId = useServersStore.getState().activeServerId;
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
        const r = await getProjects();
        if (r.ok && r.data) projects = r.data;
        else throw new Error(r.error || "Failed to load workspaces");
      }
      const rows = await fetchAllFeedback(
        projects.map((p) => ({ name: p.name, path: p.path }))
      );
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

  openThread: async (id) => {
    set({ openId: id, openItem: null, openError: null });
    try {
      const item = await fetchFeedbackShow(id);
      if (get().openId !== id) return; // navigated away mid-fetch
      set({ openItem: item, openError: null });
    } catch (err) {
      if (get().openId !== id) return;
      set({ openError: err instanceof Error ? err.message : String(err) });
    }
  },

  refetchOpen: async () => {
    const id = get().openId;
    if (!id) return;
    try {
      const item = await fetchFeedbackShow(id);
      if (get().openId !== id) return;
      set({ openItem: item, openError: null });
    } catch {
      /* keep the last good thread — the next event/mutation retries */
    }
  },

  closeThread: () => set({ openId: null, openItem: null, openError: null }),
}));

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
    const base = getBaseUrl().replace(/^http/, "ws");
    const token = getToken();
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
      const outcome = await reviveServerSession(this.serverId);
      if (!this.shouldReconnect) return;
      if (outcome === "signin-required" || outcome === "not-applicable") {
        this.shouldReconnect = false;
        return;
      }
    }
    if (this.shouldReconnect) this.open();
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
