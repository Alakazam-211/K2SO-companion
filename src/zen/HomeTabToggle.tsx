import type { ListTab } from "./homes";
import { SEARCH_BAR_HEIGHT } from "./GlassSearchBar";
import { AgentIcon, EnsoIcon, HomeIcon } from "./icons";
import { useHomesSyncBadge } from "./homesSync";

// Desktop Garden nav rail icons (`./icons`), stroke 1.7 like the ticket
// icon port.
const ICON = { size: 18, strokeWidth: 1.7 };

/** Segmented control geometry: the search bar's 44px row, 3px inset. */
export const TAB_SEG_H = SEARCH_BAR_HEIGHT;
export const TAB_SEG_PAD = 3;
export const TAB_SEG_BTN_W = 40;
/** In the header row, beside its 34px pills. */
const COMPACT_SEG_H = 34;
const COMPACT_BTN_W = 38;

/**
 * Home | Agents (| Gardens), top left of the list (Rosson 2026-11-09). Same inset-thumb
 * segmented style as the terminal Viewer/Claimer control (a6acec2): the
 * selected highlight sits inside the glass pill, clipped by it, in blue
 * glass (Rosson 2026-10-18).
 */
export function HomeTabToggle({
  tab,
  onTab,
  showGardens = false,
  compact = false,
}: {
  tab: ListTab;
  onTab: (tab: ListTab) => void;
  /** This server has Gardens (K2 `gardens-remote-v1`, iOS): a third tab. */
  showGardens?: boolean;
  /** The header row's height, not the search bar's. */
  compact?: boolean;
}) {
  const segH = compact ? COMPACT_SEG_H : TAB_SEG_H;
  const btnW = compact ? COMPACT_BTN_W : TAB_SEG_BTN_W;
  const home = tab === "home";
  const gardens = showGardens && tab === "gardens";
  const agents = !home && !gardens;
  // Homes sync (K2 0.46.1): a tiny chip with the sync server's initial.
  const sync = useHomesSyncBadge();
  return (
    <div
      role="group"
      aria-label={showGardens ? "Home, Agents or Gardens" : "Home or Agents"}
      className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill"
      data-testid="list-tab-toggle"
      data-tab={tab}
      style={{
        position: "relative",
        height: segH,
        padding: TAB_SEG_PAD,
        borderRadius: segH / 2,
        overflow: "hidden",
      }}
    >
      <span
        className="zen-seg-thumb zen-seg-thumb-blue"
        aria-hidden
        data-testid="list-tab-thumb"
        style={{
          position: "absolute",
          top: TAB_SEG_PAD,
          bottom: TAB_SEG_PAD,
          left: TAB_SEG_PAD,
          width: showGardens ? btnW : `calc(50% - ${TAB_SEG_PAD}px)`,
          borderRadius: segH / 2 - TAB_SEG_PAD,
          transform: home ? "translateX(0%)" : gardens ? "translateX(200%)" : "translateX(100%)",
        }}
      />
      <button
        type="button"
        className="zen-seg-btn flex items-center justify-center"
        aria-label={sync ? `Home, synced from ${sync.label}` : "Home"}
        title={sync ? `Home · synced from ${sync.label}` : "Home"}
        aria-pressed={home}
        data-selected={home || undefined}
        data-testid="list-tab-home"
        style={{ width: btnW, height: "100%", position: "relative" }}
        onClick={() => onTab("home")}
      >
        <HomeIcon {...ICON} testId="home-icon" />
        {sync ? (
          <span
            aria-hidden
            data-testid="home-sync-badge"
            data-server-id={sync.serverId}
            className="flex items-center justify-center font-semibold"
            style={{
              position: "absolute",
              right: 3,
              bottom: 5,
              width: 13,
              height: 13,
              borderRadius: "50%",
              fontSize: 8,
              lineHeight: 1,
              color: "#fff",
              background: "#3a3a3c",
              border: "1px solid rgba(255,255,255,.35)",
              pointerEvents: "none",
            }}
          >
            {sync.initial}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="zen-seg-btn flex items-center justify-center"
        aria-label="Agents"
        title="Agents"
        aria-pressed={agents}
        data-selected={agents || undefined}
        data-testid="list-tab-agents"
        style={{ width: btnW, height: "100%" }}
        onClick={() => onTab("agents")}
      >
        <AgentIcon {...ICON} testId="agent-icon" />
      </button>
      {showGardens ? (
        <button
          type="button"
          className="zen-seg-btn flex items-center justify-center"
          aria-label="Gardens"
          title="Gardens"
          aria-pressed={gardens}
          data-selected={gardens || undefined}
          data-testid="list-tab-gardens"
          style={{ width: btnW, height: "100%" }}
          onClick={() => onTab("gardens")}
        >
          <EnsoIcon on={gardens} size={ICON.size} testId="garden-icon" />
        </button>
      ) : null}
    </div>
  );
}
