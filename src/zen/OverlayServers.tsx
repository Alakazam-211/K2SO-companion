import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectServer } from "../lib/revive";
import { hostLabel, useServersStore, type RecoveryState, type ServerEntry } from "../stores/servers";
import { GlassSearchBar } from "./GlassSearchBar";
import { OverlayAddServer } from "./OverlayAddServer";
import { filterServers, RECOVERY_DOT, splitPinnedServer, STATE_LABEL } from "./serverList";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "./ZenHeaderBlur";
import { useZenStore } from "./zenStore";
import { useMultiServerPrefs } from "./multi/prefs";
import { usePoolEntries } from "./multi/pool";
import { serverBadge } from "./multi/rowStatus";
import { serverBellStatus, useNotifyPrefsStore } from "../stores/notifyPrefs";
import { BellIcon, useNotifyPrefsLive } from "./NotifyBell";
import { useBackHandler } from "../lib/androidBack";
import { CogIcon, GaugeIcon } from "./icons";
import { UsagePage } from "./UsagePage";
import { ServerSettingsPage } from "./ServerSettingsPage";
import { useUpdateAvailable } from "./serverUpdateStore";

const labelOf = (server: ServerEntry) => server.nickname || hostLabel(server.url);

/** How long the just-connected highlight lives (FLIP lift, then a ring
 *  pulse + checkmark). The sheet closes once it ends. */
export const JUST_CONNECTED_MS = 1000;
/** FLIP lift from the tapped row into the pinned slot. */
const FLIP_MS = 420;
/** Spring-ish: slight overshoot, then settle. */
const FLIP_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1.12)";
/** Resting floating-header height below the safe area: the 64px title
 *  row, plus the pinned card (~76px) when there is an active server. */
export const SERVERS_HEADER_PX = 64;
const SERVERS_PINNED_PX = 76;

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

function CheckMark() {
  return (
    <svg
      className="k2-server-check shrink-0"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-testid="servers-pinned-check"
    >
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        fill="none"
        stroke="#22c55e"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Thread push status under a server's name. Renders nothing until that
 *  server is known to have `thread-push-v1` and its prefs are read. */
function ServerNotifyStatus({ serverId }: { serverId: string }) {
  const on = useNotifyPrefsStore((s) => s.threadPush[serverId] === true);
  const prefs = useNotifyPrefsStore((s) => s.prefs[serverId]);
  const error = useNotifyPrefsStore((s) => s.errors[serverId] ?? null);
  if (!on || !prefs) return null;
  return (
    <span
      className="block text-[12px] truncate"
      style={{ color: "#8e8e93", lineHeight: 1.3 }}
      data-testid="server-notify-status"
    >
      {error ? `Could not save: ${error}` : serverBellStatus(prefs)}
    </span>
  );
}

/** Bell toggling Thread pushes from ONE server (`server.enabled`), using
 *  that server's own token and URL. Hidden without `thread-push-v1`. */
function ServerBell({ serverId, label }: { serverId: string; label: string }) {
  const on = useNotifyPrefsStore((s) => s.threadPush[serverId] === true);
  const prefs = useNotifyPrefsStore((s) => s.prefs[serverId]);
  if (!on || !prefs) return null;
  const enabled = prefs.server.enabled;
  return (
    <button
      type="button"
      className="shrink-0 flex items-center justify-center k2-tile"
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        color: enabled ? "#fff" : "#8e8e93",
        pointerEvents: "auto",
      }}
      aria-label={`${enabled ? "Turn off" : "Turn on"} notifications from ${label}`}
      aria-pressed={enabled}
      data-testid="server-bell"
      onClick={(e) => {
        e.stopPropagation();
        void useNotifyPrefsStore.getState().setServerEnabled(serverId, !enabled);
      }}
    >
      <BellIcon on={enabled} />
    </button>
  );
}

/** Opens the server's Usage page (subscriptions + usage + switching).
 *  Sits right of the bell on the active server's card; shown whenever
 *  that server has a session token (the page says when its K2 is too old). */
function ServerUsageButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 flex items-center justify-center k2-tile"
      style={{ width: 34, height: 34, borderRadius: 17, color: "#fff", pointerEvents: "auto" }}
      aria-label={`Usage on ${label}`}
      data-testid="server-usage"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <GaugeIcon size={18} />
    </button>
  );
}

/** Opens that server's Server settings page (identity, K2 version,
 *  shortcuts, sign out / remove). Right of the bell and the usage gauge,
 *  on every saved server's card. A blue dot when the last STORED update
 *  check said an update is available (the card never checks by itself). */
function ServerSettingsButton({
  serverId,
  label,
  onOpen,
}: {
  serverId: string;
  label: string;
  onOpen: () => void;
}) {
  const updateAvailable = useUpdateAvailable(serverId);
  return (
    <button
      type="button"
      className="relative shrink-0 flex items-center justify-center k2-tile"
      style={{ width: 34, height: 34, borderRadius: 17, color: "#fff", pointerEvents: "auto" }}
      aria-label={updateAvailable ? `Settings for ${label}, update available` : `Settings for ${label}`}
      data-testid="server-settings"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <CogIcon size={18} />
      {updateAvailable ? (
        <span
          aria-hidden
          data-testid="server-settings-update-dot"
          className="absolute"
          style={{
            top: 1,
            right: 1,
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "#0a84ff",
            boxShadow: "0 0 0 1.5px #000",
          }}
        />
      ) : null}
    </button>
  );
}

/** In-overlay server list. Tap switches the active server. Sign-in
 *  required opens OverlayAddServer. Never navigates to `/servers`.
 *  The active server is pinned in its own card under the title, inside
 *  the floating header (outside the scroller, never filtered); the list
 *  holds the others A–Z and scrolls up under both, behind the Agents /
 *  chat header's progressive blur.
 *  A successful switch FLIPs the tapped row into the pinned slot, rings it
 *  green with a checkmark, then closes. The bottom glass bar (shared with
 *  Chats) searches and `+` adds. Rendered inside the Chats column, which
 *  is sized to the visual viewport, so `inset-0` keeps the bar above the
 *  iOS keyboard. */
export function OverlayServers({ onClose }: { onClose: () => void }) {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  const tokens = useServersStore((s) => s.tokens);
  // MS38: with the multi-server list on, every other server shows its
  // pool state (dot + word), and the pinned card says what "default" means.
  const multi = useMultiServerPrefs((s) => s.multiServer);
  const poolEntries = usePoolEntries();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [usageId, setUsageId] = useState<string | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pinnedRef = useRef<HTMLDivElement | null>(null);
  const flipFrom = useRef<{ id: string; rect: DOMRect | null } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  // Android Back = Done. The add / edit form's Cancel is its own layer
  // (OverlayAddServer), registered on top while it shows.
  useBackHandler(true, onClose);
  const [headerRef, headerPx] = useMeasuredHeight(
    SERVERS_HEADER_PX + (activeServerId ? SERVERS_PINNED_PX : 0)
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { pinned, others } = splitPinnedServer(servers, activeServerId, labelOf);
  const visible = filterServers(others, query, (server) => [
    server.nickname,
    hostLabel(server.url),
    server.username,
  ]);
  // Thread push prefs (K2 0.45.5): probe + fetch every signed-in server
  // while the sheet is open; the active one also follows its events.
  useNotifyPrefsLive(servers.map((s) => s.id));
  const pinnedState: RecoveryState = pinned
    ? recovery[pinned.id] ?? "signin-required"
    : "signin-required";
  // Success signal: the tapped server became active AND reads connected.
  const justConnected =
    !!pinned && justConnectedId === pinned.id && pinnedState === "connected";

  // FLIP: the row's rect was captured before the switch; the pinned card
  // now sits at its final rect. Start it at the row and let it spring home.
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    const el = pinnedRef.current;
    if (!from?.rect || !el || from.id !== activeServerId) return;
    if (prefersReducedMotion() || typeof el.animate !== "function") return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = from.rect.left - to.left;
    const dy = from.rect.top - to.top;
    const sx = from.rect.width / to.width;
    const sy = from.rect.height / to.height;
    el.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        },
        {
          transformOrigin: "top left",
          transform: `translate(${dx * 0.45}px, ${dy * 0.45}px) scale(1.02)`,
          offset: 0.45,
        },
        {
          transformOrigin: "top left",
          transform: "none",
        },
      ],
      { duration: FLIP_MS, easing: FLIP_EASE }
    );
  }, [activeServerId]);

  // The highlight marker clears once the ring + check have played.
  useEffect(() => {
    if (!justConnectedId) return;
    const t = window.setTimeout(() => {
      setJustConnectedId(null);
      setReturningId(null);
    }, JUST_CONNECTED_MS);
    return () => window.clearTimeout(t);
  }, [justConnectedId]);

  const pick = async (server: ServerEntry) => {
    if (busy.current) return;
    busy.current = true;
    setConnectingId(server.id);
    const outcome = await connectServer(server.id);
    if (!mounted.current) return;
    setConnectingId(null);
    if (outcome === "still-valid" || outcome === "revived") {
      const store = useServersStore.getState();
      const previousId = store.activeServerId;
      flipFrom.current = {
        id: server.id,
        rect: rowRefs.current.get(server.id)?.getBoundingClientRect() ?? null,
      };
      store.setActive(server.id);
      setJustConnectedId(server.id);
      setReturningId(previousId && previousId !== server.id ? previousId : null);
      // Hold the sheet open long enough to see the new server land.
      const hold = new Promise<void>((resolve) =>
        window.setTimeout(resolve, JUST_CONNECTED_MS)
      );
      try {
        await Promise.all([useZenStore.getState().hydrateAgents(), hold]);
      } finally {
        busy.current = false;
      }
      if (mounted.current) onClose();
      return;
    }
    busy.current = false;
    if (outcome === "signin-required") {
      setEditingId(server.id);
      return;
    }
  };

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
  };

  if (adding || editingId) {
    return (
      <div
        className="absolute inset-0 flex flex-col"
        style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
        data-testid="overlay-servers"
      >
        <OverlayAddServer
          editingId={editingId}
          onCancel={closeForm}
          onSaved={onClose}
        />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-servers"
    >
      {/* Floats over the list from y=0 with the chat / Agents header's
          progressive blur. The pinned card rides inside it, so the list
          scrolls up under the title and the card; the FLIP lands the card
          above the list. Only the controls take touches. */}
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="servers-header"
        style={{
          zIndex: 3,
          paddingTop: "env(safe-area-inset-top)",
          pointerEvents: "none",
        }}
      >
      <ZenHeaderBlur testId="servers-header-blur" />
      <div ref={headerRef} className="relative w-full min-w-0" data-testid="servers-header-content">
      <div
        className="flex items-center justify-between relative"
        style={{
          minHeight: 44,
          padding: "12px 16px 8px",
        }}
      >
        <button
          type="button"
          className="text-[17px] k2-tile"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
            pointerEvents: "auto",
          }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none zen-header-text">
          Servers
        </h1>
      </div>
      {pinned ? (
        <div
          className="relative"
          style={{ padding: "4px 12px 10px" }}
          data-testid="servers-pinned"
        >
          {multi ? (
            <p
              className="text-[12px] uppercase tracking-wide"
              style={{ color: "#8e8e93", padding: "0 4px 6px" }}
              data-testid="servers-pinned-label"
            >
              Default server (Tickets, classic view)
            </p>
          ) : null}
          <div
            key={pinned.id}
            ref={pinnedRef}
            className={`k2-tile flex items-center relative${
              justConnected ? " k2-server-just-connected" : ""
            }`}
            style={{
              gap: 10,
              padding: "10px 10px 10px 14px",
              borderRadius: 14,
              pointerEvents: "auto",
            }}
            data-just-connected={justConnected ? "true" : undefined}
          >
            <button
              type="button"
              className="flex-1 min-w-0 flex items-center text-left"
              style={{ gap: 10 }}
              onClick={() => void pick(pinned)}
              aria-label={labelOf(pinned)}
              data-testid="overlay-server-pinned"
            >
              <span
                className={`shrink-0 relative${connectingId === pinned.id ? " k2-pulse" : ""}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: RECOVERY_DOT[pinnedState],
                  color: RECOVERY_DOT[pinnedState],
                }}
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[16px] font-semibold">{labelOf(pinned)}</span>
                  <span
                    className="shrink-0 flex items-center text-[11px] uppercase"
                    style={{
                      gap: 4,
                      color: pinnedState === "connected" ? "#22c55e" : RECOVERY_DOT[pinnedState],
                      letterSpacing: ".04em",
                    }}
                  >
                    {justConnected ? <CheckMark /> : null}
                    {connectingId === pinned.id
                      ? "connecting…"
                      : pinnedState === "connected"
                        ? "Connected"
                        : STATE_LABEL[pinnedState]}
                  </span>
                </span>
                <span
                  className="block text-[14px] truncate"
                  style={{ color: "#8e8e93", lineHeight: 1.3 }}
                >
                  {pinned.username} @ {hostLabel(pinned.url)}
                </span>
                <ServerNotifyStatus serverId={pinned.id} />
              </span>
            </button>
            <ServerBell serverId={pinned.id} label={labelOf(pinned)} />
            {tokens[pinned.id] ? (
              <ServerUsageButton label={labelOf(pinned)} onOpen={() => setUsageId(pinned.id)} />
            ) : null}
            <ServerSettingsButton serverId={pinned.id} label={labelOf(pinned)} onOpen={() => setSettingsId(pinned.id)} />
            <button
              type="button"
              className="shrink-0 text-[17px] k2-tile"
              style={{
                minHeight: 34,
                padding: "0 12px",
                borderRadius: 17,
                color: "#8e8e93",
              }}
              aria-label={`Edit ${labelOf(pinned)}`}
              onClick={() => setEditingId(pinned.id)}
            >
              Edit
            </button>
          </div>
        </div>
      ) : null}
      </div>
      </header>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          // Starts under the floating header (title + pinned card).
          paddingTop: underHeaderPadding(headerPx),
          paddingLeft: 8,
          paddingRight: 8,
          paddingBottom: 96,
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="overlay-servers-list"
      >
        {servers.length === 0 ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            No servers yet.
          </p>
        ) : visible.length === 0 ? (
          query.trim() ? (
            <p
              className="px-4 py-6 text-[14px]"
              style={{ color: "#8e8e93" }}
              data-testid="overlay-servers-empty"
            >
              No servers match
            </p>
          ) : null
        ) : (
          visible.map((server) => {
            const state = recovery[server.id] ?? "signin-required";
            const isConnecting = connectingId === server.id;
            const label = labelOf(server);
            const badge =
              multi && poolEntries[server.id]
                ? serverBadge({
                    saved: true,
                    hasLogin: !!tokens[server.id],
                    entry: poolEntries[server.id],
                    serverLabel: label,
                  })
                : null;
            const dot = badge ? badge.color : RECOVERY_DOT[state];
            return (
              <div
                key={server.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(server.id, el);
                  else rowRefs.current.delete(server.id);
                }}
                className={`w-full flex items-center${
                  returningId === server.id ? " k2-server-return" : ""
                }`}
                style={{
                  gap: 10,
                  padding: "10px 8px 10px 6px",
                  borderBottom: "0.5px solid rgba(255,255,255,.12)",
                }}
              >
                <button
                  type="button"
                  className="flex-1 min-w-0 flex items-center text-left"
                  style={{ gap: 10 }}
                  onClick={() => void pick(server)}
                  aria-label={label}
                  aria-busy={isConnecting || undefined}
                  data-testid="overlay-server-row"
                >
                  <span
                    className={`shrink-0 relative${isConnecting ? " k2-pulse" : ""}`}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: dot,
                      color: dot,
                    }}
                    data-testid={isConnecting ? "overlay-server-connecting" : undefined}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="truncate block text-[16px] font-semibold">{label}</span>
                    <span
                      className="block text-[14px] truncate"
                      style={{ color: "#8e8e93", lineHeight: 1.3 }}
                    >
                      {server.username} @ {hostLabel(server.url)}
                    </span>
                    <span
                      className="block text-[12px]"
                      style={{ color: dot }}
                      data-testid="overlay-server-state"
                    >
                      {isConnecting ? "connecting…" : badge ? badge.word : STATE_LABEL[state]}
                    </span>
                    <ServerNotifyStatus serverId={server.id} />
                  </span>
                </button>
                <ServerBell serverId={server.id} label={label} />
                <ServerSettingsButton serverId={server.id} label={label} onOpen={() => setSettingsId(server.id)} />
                <button
                  type="button"
                  className="shrink-0 text-[17px] k2-tile"
                  style={{
                    minHeight: 34,
                    padding: "0 12px",
                    borderRadius: 17,
                    color: "#8e8e93",
                  }}
                  aria-label={`Edit ${label}`}
                  onClick={() => setEditingId(server.id)}
                >
                  Edit
                </button>
              </div>
            );
          })
        )}
      </div>
      <GlassSearchBar
        query={query}
        onQuery={setQuery}
        placeholder="Search servers"
        searchLabel="Search servers"
        onPlus={() => setAdding(true)}
        plusLabel="Add server"
        testId="overlay-servers-bar"
        inputTestId="overlay-servers-search"
        plusTestId="overlay-servers-add"
      />
      {settingsId ? (
        <ServerSettingsPage
          serverId={settingsId}
          onBack={() => setSettingsId(null)}
          onOpenUsage={() => setUsageId(settingsId)}
        />
      ) : null}
      {usageId ? <UsagePage serverId={usageId} onBack={() => setUsageId(null)} /> : null}
    </div>
  );
}
