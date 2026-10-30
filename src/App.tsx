import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from "react-router-dom";
import { useServersStore } from "./stores/servers";
import { useWorkspacesStore } from "./stores/workspaces";
import { registerAllSignedIn, attachPushNavigation, watchPushRegistrations } from "./lib/push";
import { installBadgeServerHooks } from "./lib/badgeTotals";
import { setLifecycleEnabled } from "./lib/appLifecycle";
import { useMultiServerPrefs } from "./zen/multi/prefs";
import { Zen } from "./pages/Zen";
import { ZenTerminal } from "./pages/ZenTerminal";
import { overlayHomePath } from "./zen/overlayHome";
import { zenProjectPath, zenTerminalPath, zenTicketPath } from "./zen/terminalJump";
import { startHomesSync } from "./zen/homesSync";
import { startStashSync } from "./zen/stash/stashSync";

/** Cold-start home is always the overlay. Zero stored servers still
 *  open `/zen` (overlay Add server). Any unknown path lands here too —
 *  including the removed pre-Zen routes (`/login`, `/servers`,
 *  `/sessions`, `/settings`, the `/projects` and `/feedback` lists). */
function HomeRedirect() {
  const stored = useServersStore((s) => s.servers.length);
  return <Navigate to={overlayHomePath(stored)} replace />;
}

function ServerGuard({ children }: { children: React.ReactNode }) {
  const stored = useServersStore((s) => s.servers.length);
  if (stored === 0) return <Navigate to="/zen" replace />;
  return <>{children}</>;
}

/** Old pre-Zen deep links that name one thing keep pointing at it:
 *  `/chat/:id` → the Zen terminal, `/feedback/:id` → that ticket,
 *  `/projects/:id[/docs]` → that project chat. */
function LegacyRedirect({ to }: { to: (id: string) => string }) {
  const { id = "" } = useParams();
  return <Navigate to={to(id)} replace />;
}

/** C6 push wiring: tap deep-links + token-rotation re-register. A no-op
 *  in dormant builds (pushIsAvailable() = false — no entitlement / no
 *  google-services.json yet). */
function PushBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void attachPushNavigation((path) => navigate(path)).then((c) => {
      cleanup = c;
    });
    // Register on every signed-in server now, and again on each login.
    const stopWatch = watchPushRegistrations();
    // App-icon badge: drop a server's totals when it is signed out of or
    // removed (no-op unless push is available on iOS).
    const stopBadge = installBadgeServerHooks();
    // Homes sync (K2 0.46.1 `homes-sync-v1`): dormant until the person
    // picks a sync server; also migrates Home rows to box ids.
    const stopHomesSync = startHomesSync();
    // Stash sync (K2 0.46.7 `stash-sync-v1`): rides on Home sync's server.
    const stopStashSync = startStashSync();
    return () => {
      cleanup?.();
      stopWatch();
      stopBadge();
      stopHomesSync();
      stopStashSync();
    };
  }, []);
  return null;
}

function AppLayout() {
  const activeServerId = useServersStore((s) => s.activeServerId);

  // (Re)load workspace data whenever the ACTIVE server changes — every
  // api/client call derives base URL + token from it. Actions come from
  // getState() — subscribing to the whole store here re-rendered the
  // entire shell on every workspaces set() (isLoading flips, refresh
  // storms), which is pure overhead for the whole shell.
  useEffect(() => {
    const { refreshAll, startListening } = useWorkspacesStore.getState();
    if (activeServerId) {
      refreshAll();
      // Push re-register on every launch/server-switch, on EVERY qualifying
      // server, not just the active one (upsert by stable deviceId; joins a
      // run already in flight). Gated internally on plugin availability +
      // the Settings toggle; never throws.
      void registerAllSignedIn();
    }
    return startListening();
  }, [activeServerId]);

  return (
    <div className="flex flex-col h-full">
      <PushBridge />
      <div className="flex-1 overflow-hidden">
        <Routes>
          {/* No server required so the overlay can offer Add server. */}
          <Route path="/zen" element={<Zen />} />
          {/* Zen thread's terminal button: the glass terminal page. */}
          <Route path="/zen/terminal/:terminalId" element={<ServerGuard><ZenTerminal /></ServerGuard>} />
          {/* Pre-Zen UI was removed (4.1.0). Its deep links that name one
              thing redirect to the Zen screen for it; the rest (`/login`,
              `/servers`, `/sessions`, `/settings`, the lists) go home. */}
          <Route path="/chat/:id" element={<LegacyRedirect to={zenTerminalPath} />} />
          <Route path="/feedback/:id" element={<LegacyRedirect to={zenTicketPath} />} />
          <Route path="/projects/:id/*" element={<LegacyRedirect to={zenProjectPath} />} />
          <Route path="*" element={<HomeRedirect />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  const hydrated = useServersStore((s) => s.hydrated);
  // MS28: room sockets close in the background and reopen in the
  // foreground only with the multi-server flag on (off = today).
  const multiServer = useMultiServerPrefs((s) => s.multiServer);
  useEffect(() => setLifecycleEnabled(multiServer), [multiServer]);

  useEffect(() => {
    // Load the persisted multi-server model (+ one-time migration of the
    // legacy auth.json session / k2_connections list).
    void useServersStore.getState().hydrate();
  }, []);

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[var(--accent)] text-[13px]">Connecting...</div>
      </div>
    );
  }

  return (
    // Transitions OFF: react-router v7 wraps navigation state updates in
    // React.startTransition by default, but zustand's useSyncExternalStore
    // updates are forced-sync and INTERRUPT pending transitions — under
    // store churn (revive/reconnect recovery flaps, refresh storms) a
    // navigation could starve forever and silently no-op. We use no
    // Suspense/lazy routes, so sync router updates lose nothing. This is
    // the router's documented opt-out for useSyncExternalStore apps
    // (`useTransitions`; it was `unstable_useTransitions` before 7.18).
    <BrowserRouter useTransitions={false}>
      <Routes>
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  );
}
