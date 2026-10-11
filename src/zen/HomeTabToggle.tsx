import type { ListTab } from "./homes";
import { SEARCH_BAR_HEIGHT } from "./GlassSearchBar";
import { AgentIcon, HomeIcon } from "./icons";

// Desktop Garden nav rail icons (`./icons`), stroke 1.7 like the ticket
// icon port.
const ICON = { size: 18, strokeWidth: 1.7 };

/** Segmented control geometry: the search bar's 44px row, 3px inset. */
export const TAB_SEG_H = SEARCH_BAR_HEIGHT;
export const TAB_SEG_PAD = 3;
export const TAB_SEG_BTN_W = 40;
const THUMB_R = TAB_SEG_H / 2 - TAB_SEG_PAD;

/**
 * Home | Agents, left of the Agents search field (HM1). Same inset-thumb
 * segmented style as the terminal Viewer/Claimer control (a6acec2): the
 * selected highlight sits inside the glass pill, clipped by it.
 */
export function HomeTabToggle({ tab, onTab }: { tab: ListTab; onTab: (tab: ListTab) => void }) {
  const home = tab === "home";
  return (
    <div
      role="group"
      aria-label="Home or Agents"
      className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill"
      data-testid="list-tab-toggle"
      data-tab={tab}
      style={{
        position: "relative",
        height: TAB_SEG_H,
        padding: TAB_SEG_PAD,
        borderRadius: TAB_SEG_H / 2,
        overflow: "hidden",
      }}
    >
      <span
        className="zen-seg-thumb"
        aria-hidden
        data-testid="list-tab-thumb"
        style={{
          position: "absolute",
          top: TAB_SEG_PAD,
          bottom: TAB_SEG_PAD,
          left: TAB_SEG_PAD,
          width: `calc(50% - ${TAB_SEG_PAD}px)`,
          borderRadius: THUMB_R,
          transform: home ? "translateX(0%)" : "translateX(100%)",
        }}
      />
      <button
        type="button"
        className="zen-seg-btn flex items-center justify-center"
        aria-label="Home"
        title="Home"
        aria-pressed={home}
        data-selected={home || undefined}
        data-testid="list-tab-home"
        style={{ width: TAB_SEG_BTN_W, height: "100%" }}
        onClick={() => onTab("home")}
      >
        <HomeIcon {...ICON} testId="home-icon" />
      </button>
      <button
        type="button"
        className="zen-seg-btn flex items-center justify-center"
        aria-label="Agents"
        title="Agents"
        aria-pressed={!home}
        data-selected={!home || undefined}
        data-testid="list-tab-agents"
        style={{ width: TAB_SEG_BTN_W, height: "100%" }}
        onClick={() => onTab("agents")}
      >
        <AgentIcon {...ICON} testId="agent-icon" />
      </button>
    </div>
  );
}
