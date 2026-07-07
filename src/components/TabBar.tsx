import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServersStore } from "../stores/servers";
import { useFeedbackStore } from "../stores/feedback";

// C1 nav: Servers is the HOME tab; Projects/Feedback are placeholder routes
// that slices C2/C3 fill in.
const tabs = [
  {
    path: "/servers",
    label: "Servers",
    icon: (
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </>
    ),
  },
  {
    path: "/sessions",
    label: "Sessions",
    icon: (
      <>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </>
    ),
  },
  {
    path: "/projects",
    label: "Projects",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </>
    ),
  },
  {
    path: "/feedback",
    label: "Feedback",
    icon: (
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    ),
  },
  {
    path: "/settings",
    label: "Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
  },
] as const;

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();

  // Hide tab bar when inside a chat session, an open feedback thread
  // (C3 — /feedback/:id hides nav chrome like /chat/:id does), or the
  // add/edit-server flow (chrome-free by design; the route now lives
  // inside the shell so navigation can't unmount AppLayout).
  if (location.pathname.startsWith("/chat/") || /^\/feedback\/./.test(location.pathname) || location.pathname === "/login") return null;

  return (
    <nav className="flex border-t border-[var(--border)] bg-[var(--background)] shrink-0 px-2" style={{ paddingBottom: "calc(20px + var(--android-nav-lift, 0px))" }}>
      {tabs.map((tab) => {
        const isActive = location.pathname.startsWith(tab.path);
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            className={`relative flex-1 flex flex-col items-center py-2.5 gap-1 transition-colors duration-150 ${
              isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
            }`}
          >
            {tab.path === "/feedback" && <FeedbackTabBadge />}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {tab.icon}
            </svg>
            <span className="text-[10px]">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** C3 — waiting-items count on the Feedback tab. Rendering here (the tab
 *  bar is on every page) also kicks the feedback store's first load +
 *  /events subscription per active server, so the badge is live before
 *  the Feedback page is ever opened. */
function FeedbackTabBadge() {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const count = useFeedbackStore((s) => s.waitingCount);

  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
  }, [activeServerId]);

  if (count === 0) return null;
  return (
    <span className="absolute top-1 left-1/2 ml-[8px] min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--warning)] text-black text-[9px] font-bold leading-[15px] text-center">
      {count > 99 ? "99+" : count}
    </span>
  );
}
