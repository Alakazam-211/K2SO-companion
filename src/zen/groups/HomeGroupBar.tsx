// The Home groups bar (K2 0.46.13, adapted for the phone; brief §1.5/§1.6):
// one bare glyph per group in a strip above the bottom search bar. The
// current group is in the accent text colour, the rest muted; a group with
// no icon (or one this build can't draw) shows its number. Tap selects; a
// long press (500 ms, as the desktop's) opens the Groups sheet on that
// group. When the groups don't fit, a chevron at each end (only while more
// groups sit that way) pages the strip; the current group is kept centred.
// The strip never scrolls under the finger: a sideways swipe on it is the
// group swipe (`useGroupSwipe`), and its accent blend follows the swipe
// (two stacked layers crossfading: no `color-mix`, iOS 15).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { HOLD_MENU_MS, HOLD_SLOP_PX } from "../useHoldMenu";
import { GroupGlyph } from "./GroupGlyph";
import { accentShare, useGroupSwipeStore } from "./groupSwipe";

/** The glyph (pt) and each group's touch target (iOS-sized). */
export const GROUP_BAR_GLYPH_PX = 20;
export const GROUP_BAR_TARGET_PX = 44;
export const GROUP_BAR_HEIGHT = 44;
const CHEVRON_W = 28;

export interface GroupBarItem {
  id: string;
  name: string;
  icon: string | null;
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

export function HomeGroupBar({
  groups,
  currentId,
  onSelect,
  onOpenGroups,
  barRef,
}: {
  groups: GroupBarItem[];
  currentId: string;
  onSelect: (id: string) => void;
  /** Long press: the Groups sheet on that group. */
  onOpenGroups: (id: string) => void;
  /** The strip (the group swipe may start anywhere on it). */
  barRef?: Ref<HTMLElement>;
}) {
  const swipe = useGroupSwipeStore((s) => s.swipe);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const currentIndex = Math.max(0, groups.findIndex((g) => g.id === currentId));

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  // The current group stays centred (on open and after every switch).
  useLayoutEffect(() => {
    const el = scroller.current;
    const btn = el
      ? Array.from(el.querySelectorAll<HTMLElement>("[data-group-id]")).find((x) => x.dataset.groupId === currentId)
      : null;
    if (el && btn) {
      const want = btn.offsetLeft + btn.offsetWidth / 2 - el.clientWidth / 2;
      el.scrollLeft = Math.max(0, Math.min(want, el.scrollWidth - el.clientWidth));
    }
    measure();
  }, [currentId, groups.length, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, Math.min(el.scrollLeft + dir * el.clientWidth, el.scrollWidth - el.clientWidth));
    measure();
  };

  // Long press → the Groups sheet; its release never also selects.
  const press = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const held = useRef(false);
  const clearPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => clearPress, []);

  const chevron = (dir: "left" | "right") => (
    <button
      type="button"
      tabIndex={-1}
      className="shrink-0 flex items-center justify-center bg-transparent border-0 p-0"
      style={{ width: CHEVRON_W, height: GROUP_BAR_HEIGHT, color: "var(--color-text-muted)" }}
      aria-label={dir === "left" ? "Earlier groups" : "More groups"}
      onClick={() => page(dir === "left" ? -1 : 1)}
      data-testid={`group-bar-${dir}`}
    >
      <Chevron dir={dir} />
    </button>
  );

  return (
    <nav
      ref={barRef}
      aria-label="Groups"
      className="zen-glass zen-glass-pill flex items-center"
      style={{ height: GROUP_BAR_HEIGHT, maxWidth: "100%", padding: "0 4px", touchAction: "pan-y" }}
      data-no-pin="1"
      data-testid="home-group-bar"
    >
      {edges.left ? chevron("left") : null}
      <div
        ref={scroller}
        className="min-w-0 flex-1"
        style={{ overflow: "hidden" }}
        onScroll={measure}
        data-testid="home-group-bar-strip"
      >
        <div className="flex items-center" style={{ width: "max-content", margin: "0 auto" }}>
          {groups.map((g, i) => {
            const current = g.id === currentId;
            const a = accentShare(i, currentIndex, groups.length, swipe);
            return (
              <button
                key={g.id}
                type="button"
                className="relative shrink-0 grid place-items-center bg-transparent border-0 p-0"
                style={{
                  width: GROUP_BAR_TARGET_PX,
                  height: GROUP_BAR_HEIGHT,
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  WebkitTouchCallout: "none",
                }}
                aria-label={current ? `${g.name}, current group` : g.name}
                aria-current={current ? "true" : undefined}
                data-group-id={g.id}
                data-current={current ? "1" : undefined}
                data-testid={`group-bar-item-${i}`}
                onPointerDown={(e) => {
                  held.current = false;
                  if (e.button && e.button !== 0) return;
                  clearPress();
                  const p = { id: g.id, x: e.clientX, y: e.clientY, timer: null as ReturnType<typeof setTimeout> | null };
                  p.timer = setTimeout(() => {
                    if (press.current !== p) return;
                    press.current = null;
                    held.current = true;
                    onOpenGroups(g.id);
                  }, HOLD_MENU_MS);
                  press.current = p;
                }}
                onPointerMove={(e) => {
                  const p = press.current;
                  if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_SLOP_PX) clearPress();
                }}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onContextMenu={(e) => {
                  e.preventDefault();
                  clearPress();
                  held.current = true;
                  onOpenGroups(g.id);
                }}
                onClick={() => {
                  if (held.current) {
                    held.current = false;
                    return;
                  }
                  onSelect(g.id);
                }}
              >
                {/* Muted under, accent over: the accent's share follows the swipe. */}
                <span
                  aria-hidden
                  className="col-start-1 row-start-1 flex items-center justify-center"
                  style={{ color: "var(--color-text-muted)", opacity: 1 - a }}
                >
                  <GroupGlyph icon={g.icon} n={i + 1} size={GROUP_BAR_GLYPH_PX} />
                </span>
                <span
                  aria-hidden
                  className="col-start-1 row-start-1 flex items-center justify-center"
                  style={{ color: "var(--color-accent-text)", opacity: a }}
                  data-testid={current ? "group-bar-current-ink" : undefined}
                >
                  <GroupGlyph icon={g.icon} n={i + 1} size={GROUP_BAR_GLYPH_PX} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {edges.right ? chevron("right") : null}
    </nav>
  );
}
