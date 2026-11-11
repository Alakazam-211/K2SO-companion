import { HeartPulse, MessageCircle, MessagesSquare } from "lucide-react";
import { TerminalIcon } from "./icons";
import { THREAD_VIEW_LABEL, type ThreadView } from "./threadViews";

// Terminal | Thread | Chatter | Heartbeats on the chat header (Rosson
// 2026-11-11, a test; K2 Projects' agent-tile switch). The Home tab
// switch's inset-thumb capsule (HomeTabToggle), at the header buttons'
// 36px. One is always selected; pressing it again does nothing.

export const VIEW_SEG_H = 36;
const PAD = 3;
const BTN_W = VIEW_SEG_H - 2 * PAD;
const ORDER: ThreadView[] = ["terminal", "thread", "chatter", "heartbeats"];
const ICON = { size: 17, strokeWidth: 2 };

function Glyph({ view }: { view: ThreadView }) {
  if (view === "terminal") return <TerminalIcon {...ICON} />;
  if (view === "thread") return <MessageCircle {...ICON} aria-hidden="true" />;
  if (view === "chatter") return <MessagesSquare {...ICON} aria-hidden="true" />;
  return <HeartPulse {...ICON} aria-hidden="true" />;
}

export function ThreadViewSwitch({
  view,
  onView,
  busy,
}: {
  view: ThreadView;
  onView: (view: ThreadView) => void;
  /** Terminal is starting the agent: a spinner in its place. */
  busy?: boolean;
}) {
  const at = Math.max(0, ORDER.indexOf(view));
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill"
      data-testid="thread-view-switch"
      data-view={view}
      data-glass-shape="button"
      style={{ position: "relative", height: VIEW_SEG_H, padding: PAD, borderRadius: VIEW_SEG_H / 2, overflow: "hidden" }}
    >
      <span
        className="zen-seg-thumb zen-seg-thumb-blue"
        aria-hidden
        style={{
          position: "absolute",
          top: PAD,
          bottom: PAD,
          left: PAD,
          width: BTN_W,
          borderRadius: VIEW_SEG_H / 2 - PAD,
          transform: `translateX(${at * 100}%)`,
        }}
      />
      {ORDER.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === view}
          aria-label={THREAD_VIEW_LABEL[v]}
          className="zen-seg-btn flex items-center justify-center"
          // Full white like the header's buttons beside it (Rosson
          // 2026-11-11), not the shared segment's 55% for the unselected.
          style={{ width: BTN_W, height: "100%", position: "relative", color: "#fff" }}
          onClick={(e) => {
            e.stopPropagation();
            if (v !== view || v === "terminal") onView(v);
          }}
          data-testid={`thread-view-${v}`}
          aria-busy={v === "terminal" && busy ? true : undefined}
        >
          {v === "terminal" && busy ? (
            <span
              data-testid="terminal-waking"
              className="block w-4 h-4 rounded-full border-2 border-current border-t-transparent opacity-70 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Glyph view={v} />
          )}
        </button>
      ))}
    </div>
  );
}
