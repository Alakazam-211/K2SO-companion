import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useServersStore, getActiveServer } from "./stores/servers";
import { useWorkspacesStore } from "./stores/workspaces";
import { ensureRegistered, attachPushNavigation } from "./lib/push";
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

/** C1 guard: content pages need at least one saved server. A fresh install
 *  (0 servers) lands on /servers with the add CTA — login is no longer the
 *  app gate. A server in `signin-required` still renders content; the
 *  footer + Servers page surface the state instead of a hard logout. */
function ServerGuard({ children }: { children: React.ReactNode }) {
  const hasServers = useServersStore((s) => s.servers.length > 0);
  if (!hasServers) return <Navigate to="/servers" replace />;
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
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)]" style={{ flexShrink: 0 }}>
      <span className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
        K2
      </span>
      <span className="text-[var(--text-muted)] text-[11px]">
        {allSessions.length} active
      </span>
      {/* Refresh */}
      <button
        onClick={handleRefresh}
        className="w-8 h-8 flex items-center justify-center text-[var(--text-muted)]"
        style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    return () => cleanup?.();
  }, []);
  return null;
}

function AppLayout() {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const { refreshAll, startListening } = useWorkspacesStore();

  // (Re)load workspace data whenever the ACTIVE server changes — every
  // api/client call derives base URL + token from it.
  useEffect(() => {
    if (activeServerId) {
      refreshAll();
      // Push re-register on every launch/server-switch (upsert by stable
      // deviceId — absorbs token rotation). Gated internally on plugin
      // availability + the Settings toggle; never throws.
      const active = getActiveServer();
      if (active) void ensureRegistered(active);
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
          <Route path="/sessions" element={<ServerGuard><Sessions /></ServerGuard>} />
          <Route path="/chat/:terminalId" element={<ServerGuard><ChatSession /></ServerGuard>} />
          <Route path="/projects/*" element={<ServerGuard><ProjectsPage /></ServerGuard>} />
          <Route path="/feedback/*" element={<ServerGuard><Feedback /></ServerGuard>} />
          <Route path="/settings" element={<ServerGuard><Settings /></ServerGuard>} />
          <Route path="*" element={<Navigate to="/servers" replace />} />
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
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  );
}
