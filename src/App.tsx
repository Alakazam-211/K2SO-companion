import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useServersStore } from "./stores/servers";
import { useWorkspacesStore } from "./stores/workspaces";
import { registerAllSignedIn, attachPushNavigation, watchPushRegistrations } from "./lib/push";
import { installBadgeServerHooks } from "./lib/badgeTotals";
import { setLifecycleEnabled } from "./lib/appLifecycle";
import { useMultiServerPrefs } from "./zen/multi/prefs";
import { TabBar } from "./components/TabBar";
import { ServerFooter } from "./components/ServerFooter";
import { Login } from "./pages/Login";
import { Servers } from "./pages/Servers";
import { Sessions } from "./pages/Sessions";
import { ChatSession } from "./pages/ChatSession";
import { Settings } from "./pages/Settings";
import { ProjectsPage } from "./pages/Projects";
import { Feedback } from "./pages/Feedback";
import { NewSessionModal } from "./components/NewSessionModal";
import { Zen } from "./pages/Zen";
import { ZenTerminal } from "./pages/ZenTerminal";
import { overlayHomePath } from "./zen/overlayHome";
import { ZenReturnButton } from "./zen/ZenReturnButton";
import { startHomesSync } from "./zen/homesSync";

/** Cold-start home is always the overlay. Zero stored servers still
 *  open `/zen` (overlay Add server). `/login` and `/servers` are old UI. */
function HomeRedirect() {
  const stored = useServersStore((s) => s.servers.length);
  return <Navigate to={overlayHomePath(stored)} replace />;
}

function ServerGuard({ children }: { children: React.ReactNode }) {
  const stored = useServersStore((s) => s.servers.length);
  if (stored === 0) return <Navigate to="/zen" replace />;
  return <>{children}</>;
}

function AppHeader({ onNewSession }: { onNewSession: () => void }) {
  const location = useLocation();
  const allSessions = useWorkspacesStore((s) => s.allSessions);
  const refreshAll = useWorkspacesStore((s) => s.refreshAll);
  const [refreshing, setRefreshing] = useState(false);

  // This header is session-list chrome — Servers/Projects/Feedback/Settings
  // (and the chat view) bring their own.
  if (!location.pathname.startsWith("/sessions")) return null;

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshAll();
    setRefreshing(false);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--chrome)]" style={{ flexShrink: 0 }}>
      <span className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
        K2
      </span>
      <span className="text-[var(--text-muted)] text-[11px]">
        {allSessions.length} active
      </span>
      <ZenReturnButton />
      {/* Refresh */}
      <button
        onClick={handleRefresh}
        className="w-8 h-8 flex items-center justify-center text-[var(--text-muted)]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}>
          <path d="M21 2v6h-6" />
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M3 22v-6h6" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
      </button>
      {/* New session */}
      <button
        onClick={onNewSession}
        className="w-8 h-8 flex items-center justify-center text-[var(--accent)] border border-[var(--accent-dim)]"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
      </button>
    </div>
  );
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
    return () => {
      cleanup?.();
      stopWatch();
      stopBadge();
      stopHomesSync();
    };
  }, []);
  return null;
}

function AppLayout() {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const activeServerId = useServersStore((s) => s.activeServerId);

  // (Re)load workspace data whenever the ACTIVE server changes — every
  // api/client call derives base URL + token from it. Actions come from
  // getState() — subscribing to the whole store here re-rendered the
  // entire shell on every workspaces set() (isLoading flips, refresh
  // storms), which is pure overhead now that the shell hosts /login too.
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
      <AppHeader onNewSession={() => setNewSessionOpen(true)} />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/servers" element={<Servers />} />
          {/* Add/edit-server lives INSIDE the shell: crossing /servers ↔
              /login must never unmount AppLayout. The old top-level sibling
              route demolished the whole shell each way — remounting
              PushBridge + the workspace listeners mid-navigation, whose
              plugin invoke churn could deadlock tauri's iOS IPC bridge
              (tauri < 2.11.5) and froze the app. The bars below hide
              themselves on /login, so the page still renders chrome-free. */}
          <Route path="/login" element={<Login />} />
          <Route path="/sessions" element={<ServerGuard><Sessions /></ServerGuard>} />
          <Route path="/chat/:terminalId" element={<ServerGuard><ChatSession /></ServerGuard>} />
          <Route path="/projects/*" element={<ServerGuard><ProjectsPage /></ServerGuard>} />
          <Route path="/feedback/*" element={<ServerGuard><Feedback /></ServerGuard>} />
          <Route path="/settings" element={<ServerGuard><Settings /></ServerGuard>} />
          {/* Stub door: toggle location is not decided. No server required
              so the structure is visible on the Vite loop. Data is labelled STUB. */}
          <Route path="/zen" element={<Zen />} />
          {/* Zen thread's terminal button: glass copy of /chat/:id. */}
          <Route path="/zen/terminal/:terminalId" element={<ServerGuard><ZenTerminal /></ServerGuard>} />
          <Route path="*" element={<HomeRedirect />} />
        </Routes>
      </div>
      <ServerFooter />
      <TabBar />
      <NewSessionModal open={newSessionOpen} onClose={() => setNewSessionOpen(false)} />
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
    // the router's documented opt-out for useSyncExternalStore apps.
    <BrowserRouter unstable_useTransitions={false}>
      <Routes>
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  );
}
