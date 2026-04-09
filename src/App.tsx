import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/auth";
import { useWorkspacesStore } from "./stores/workspaces";
import { HeaderBar } from "./components/HeaderBar";
import { WorkspaceDrawer } from "./components/WorkspaceRail";
import { TabBar } from "./components/TabBar";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { Login } from "./pages/Login";
import { Workspaces } from "./pages/Workspaces";
import { ChatSession } from "./pages/ChatSession";
import { Settings } from "./pages/Settings";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const { refreshAll, startListening } = useWorkspacesStore();

  useEffect(() => {
    refreshAll();
    return startListening();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <HeaderBar
        onMenuOpen={() => setDrawerOpen(true)}
        onSessionSwitch={() => setSessionSwitcherOpen(true)}
      />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/chat/:terminalId" element={<ChatSession />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/workspaces" replace />} />
        </Routes>
      </div>
      <TabBar />
      <WorkspaceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <SessionSwitcher open={sessionSwitcherOpen} onClose={() => setSessionSwitcherOpen(false)} />
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
