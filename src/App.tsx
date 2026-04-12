import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "./stores/auth";
import { useWorkspacesStore } from "./stores/workspaces";
import { TabBar } from "./components/TabBar";
import { Login } from "./pages/Login";
import { Sessions } from "./pages/Sessions";
import { ChatSession } from "./pages/ChatSession";
import { Settings } from "./pages/Settings";
import { NewSessionModal } from "./components/NewSessionModal";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppHeader({ onNewSession }: { onNewSession: () => void }) {
  const location = useLocation();
  const allSessions = useWorkspacesStore((s) => s.allSessions);

  if (location.pathname.startsWith("/chat/")) return null;
  if (location.pathname === "/settings") return null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)]" style={{ flexShrink: 0 }}>
      <span className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
        K2
      </span>
      <span className="text-[var(--text-muted)] text-[11px]">
        {allSessions.length} active
      </span>
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

function AppLayout() {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const { refreshAll, startListening } = useWorkspacesStore();

  useEffect(() => {
    refreshAll();
    return startListening();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <AppHeader onNewSession={() => setNewSessionOpen(true)} />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/chat/:terminalId" element={<ChatSession />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/sessions" replace />} />
        </Routes>
      </div>
      <TabBar />
      <NewSessionModal open={newSessionOpen} onClose={() => setNewSessionOpen(false)} />
    </div>
  );
}

export default function App() {
  const { restoreSession } = useAuthStore();
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    restoreSession().finally(() => setIsRestoring(false));
  }, []);

  if (isRestoring) {
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
        <Route
          path="/*"
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
