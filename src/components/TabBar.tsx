import { useLocation, useNavigate } from "react-router-dom";

const tabs = [
  { path: "/workspaces", label: "Workspaces", icon: "⊞" },
  { path: "/settings", label: "Settings", icon: "⚙" },
] as const;

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();

  // Hide tab bar when inside a chat session
  if (location.pathname.startsWith("/chat/")) return null;

  return (
    <nav className="flex border-t border-[var(--border)] bg-[var(--background)] shrink-0 px-2 pb-1">
      {tabs.map((tab) => {
        const isActive = location.pathname.startsWith(tab.path);
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 transition-colors duration-150 ${
              isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
            }`}
          >
            <span className="text-lg">{tab.icon}</span>
            <span className="text-[10px]">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
