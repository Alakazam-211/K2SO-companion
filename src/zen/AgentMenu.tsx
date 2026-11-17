import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../lib/androidBack";
import { useViewport } from "../lib/useViewportHeight";
import { useMenuSolidFill } from "./AttachMenu";
import type { RowRef } from "./unread";
import { MuteMenuItems } from "./UnreadMarks";
import { rectOf, type HeldMenu, type MenuRect } from "./useHoldMenu";

// The one press-and-hold menu for an agent (Agents rows, pinned avatars,
// Home rows). Every row action lives here: Open, Pin / Unpin, Mute,
// Move to group…, Rearrange, Move to Home…, Remove from Home. Glass, iOS-style: label
// on the left, glyph on the right, under the pressed row (above it when
// there is no room below).
//
// Lifted (`lift`: Home rows and Home chat messages; K2 Design's 4.3.0
// review): the page behind is dimmed and blurred, the held row or message
// is drawn again above the dim right where it sits (the Thread's held
// bubble, grown and outlined), the menu takes the menu material at its
// full fill, and a `head` (the quick emoji) floats on its own above the
// lifted message, clear of its reaction chips.

const REMOVE_RED = "var(--color-status-error)";
const ITEM_H = 44;
const MENU_W = 220;

export type AgentMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** Shown but turned off, with `note` saying why (Pin at 9 pins). */
  disabled?: boolean;
  note?: string;
  onSelect: () => void;
};

/** An entry: an action, or the Mute / Unmute items for a Thread. */
export type AgentMenuEntry =
  | AgentMenuItem
  | { key: "mute"; mute: { serverId: string | null | undefined; rowRef: RowRef | null } };

function isMute(e: AgentMenuEntry): e is Extract<AgentMenuEntry, { mute: unknown }> {
  return "mute" in e;
}

/** Where the menu sits for a pressed `rect`. Pure (tests). */
/** `visibleBottom`: the bottom of what can be seen (px from the top): the
 *  keyboard's top while it is up, else the window's height. The menu is
 *  always placed by its `top`, so it lands right whatever the window's
 *  layout height is (iOS keeps that at full height under the keyboard). */
export function agentMenuPlacement(
  rect: MenuRect,
  count: number,
  align: "center" | "end",
  visibleBottom: number
): { top?: number; bottom?: number; left?: string; right?: number; maxHeight: number } {
  const h = count * ITEM_H + 12;
  const below = rect.bottom + 6;
  const fitsBelow = below + h <= visibleBottom - 16;
  const fitsAbove = rect.top - 6 - h >= 16;
  const x =
    align === "center"
      ? { left: `clamp(12px, ${rect.left + rect.width / 2}px - ${MENU_W / 2}px, calc(100vw - ${MENU_W + 12}px))` }
      : { right: 16 };
  // No room below (the keyboard, the bottom of the screen): above, if it
  // fits there, or else whichever side has more room.
  if (!fitsBelow && (fitsAbove || rect.top - 22 > visibleBottom - below - 16)) {
    const room = rect.top - 22;
    return { ...x, top: Math.max(16, rect.top - 6 - Math.min(h, room)), maxHeight: room };
  }
  return { ...x, top: below, maxHeight: Math.max(ITEM_H * 2, visibleBottom - below - 16) };
}

/** The gap between the lifted row and the menu or the head. */
const LIFT_GAP = 8;
/** A lifted menu sits over every pane and the Home chat (z 40), under
 *  the sheets (55 and up). */
const LIFT_Z = 45;
/** What the lifted copy must not carry: no duplicate ids or test ids, and
 *  nothing a hold, a jump or Rearrange looks for. */
const CLONE_STRIP = ["id", "data-testid", "data-home-row", "data-home-chat-msg", "data-home-chat-lift", "data-message-hold", "data-rearrange-key"];

/** A lifted menu's pieces: the head (the quick emoji) above the lifted
 *  rect and the menu under it. A message too low for the menu below is
 *  lifted up (`shift` px) to make room, as iOS moves its preview; when it
 *  still can't fit, the head goes under the rect if it can't go above,
 *  and the menu past the head (above it all with no room below). Pure
 *  (tests). */
export function liftedMenuPlacement(
  rect: MenuRect,
  count: number,
  align: "center" | "end",
  visibleBottom: number,
  headPx: number,
  visibleTop = 0
): { menu: ReturnType<typeof agentMenuPlacement>; head: { top: number } | null; shift: number } {
  if (!(headPx > 0)) return { menu: agentMenuPlacement(rect, count, align, visibleBottom), head: null, shift: 0 };
  const menuH = count * ITEM_H + 12;
  const deficit = rect.bottom + 6 + menuH + 16 - visibleBottom;
  const room = rect.top - LIFT_GAP - headPx - (visibleTop + 16);
  const shift = deficit > 0 && room > 0 ? Math.min(deficit, room) : 0;
  const placed = liftedPieces({ ...rect, top: rect.top - shift, bottom: rect.bottom - shift }, count, align, visibleBottom, headPx, visibleTop);
  return { ...placed, shift };
}

function liftedPieces(
  rect: MenuRect,
  count: number,
  align: "center" | "end",
  visibleBottom: number,
  headPx: number,
  visibleTop: number
): { menu: ReturnType<typeof agentMenuPlacement>; head: { top: number } } {
  const above = rect.top - LIFT_GAP - headPx;
  if (above >= visibleTop + 16) {
    // agentMenuPlacement keeps 6px off its rect: the menu clears the head.
    const grown = { ...rect, top: above - LIFT_GAP + 6 };
    return { menu: agentMenuPlacement(grown, count, align, visibleBottom), head: { top: above } };
  }
  const headTop = rect.bottom + LIFT_GAP;
  const grown = { ...rect, bottom: headTop + headPx + LIFT_GAP - 6 };
  return { menu: agentMenuPlacement(grown, count, align, visibleBottom), head: { top: headTop } };
}

/** A copy of `el` for the lift: no ids or hooks, no margins, its own
 *  width (a row's percent max width has no list to measure up there). */
export function liftCopy(el: HTMLElement, width: number): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("*"))]) {
    for (const a of CLONE_STRIP) n.removeAttribute(a);
  }
  copy.style.margin = "0";
  copy.style.width = `${width}px`;
  copy.style.maxWidth = "none";
  copy.style.visibility = "visible";
  return copy;
}

type Lifted = { rect: MenuRect; el: HTMLElement };

export function AgentMenu({
  label,
  menu,
  entries,
  onClose,
  align = "end",
  testId = "agent-menu",
  head,
  headPx = 0,
  lift,
  liftSurface = false,
}: {
  /** The menu's accessible name (the agent's). */
  label: string;
  menu: HeldMenu;
  entries: AgentMenuEntry[];
  onClose: () => void;
  align?: "center" | "end";
  testId?: string;
  /** A row above the entries (Home chat's quick reactions). `take` is the
   *  menu's guard: true only for a fresh press inside the menu, so the
   *  hold's own release never picks from it. */
  head?: (take: () => boolean) => ReactNode;
  /** The head's height (px), for the placement. */
  headPx?: number;
  /** The held row or message to lift above the dim (found as the menu
   *  opens). Given: dim and blur behind, the menu material at its full
   *  fill, the head floated above the lifted rect. */
  lift?: () => HTMLElement | null;
  /** The lifted copy gets a raised surface under it (a list row has no
   *  fill of its own; a message's bubbles do). */
  liftSurface?: boolean;
}) {
  // Clicks count only after a fresh press inside the menu (or a key), so
  // the hold's own release / synthetic click never runs an item.
  const armed = useRef(menu.armed);
  useEffect(() => {
    armed.current = menu.armed;
  }, [menu]);
  const take = () => {
    if (!armed.current) return false;
    armed.current = false;
    return true;
  };
  useBackHandler(true, onClose);
  // What is visible: above the keyboard while it is up (Riley: the newest
  // message's menu went under the keyboard).
  const vp = useViewport();
  const fill = useMenuSolidFill();

  // The lift: the held element, measured as the menu opens; a copy of it
  // drawn above the dim, the element itself hidden under the copy.
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const liftHost = useRef<HTMLDivElement | null>(null);
  const liftRef = useRef(lift);
  liftRef.current = lift;
  const focus = !!lift;
  useLayoutEffect(() => {
    const el = focus ? (liftRef.current?.() ?? null) : null;
    if (!el) {
      setLifted(null);
      return;
    }
    setLifted({ rect: rectOf(el), el });
    const was = el.style.visibility;
    el.style.visibility = "hidden";
    return () => {
      el.style.visibility = was;
    };
  }, [focus, menu.id, menu.rect]);
  useLayoutEffect(() => {
    const host = liftHost.current;
    if (!host || !lifted) return;
    host.replaceChildren(liftCopy(lifted.el, lifted.rect.width));
    return () => host.replaceChildren();
  }, [lifted]);

  const visibleBottom = vp.offsetTop + vp.height;
  const rect = lifted?.rect ?? menu.rect;
  const floated = focus && !!head;
  const placed = floated
    ? liftedMenuPlacement(rect, entries.length, align, visibleBottom, headPx, vp.offsetTop)
    : { menu: agentMenuPlacement(rect, entries.length + (head ? headPx / ITEM_H : 0), align, visibleBottom), head: null, shift: 0 };
  const place = placed.menu;
  const z = focus ? LIFT_Z : 29;
  const material: CSSProperties = focus ? { background: fill } : {};

  const body = (
    <div
      data-no-pin="1"
      onPointerDownCapture={() => {
        armed.current = true;
      }}
      onKeyDownCapture={() => {
        armed.current = true;
      }}
    >
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 border-0 p-0"
        style={{
          zIndex: z,
          background: focus ? "var(--color-scrim)" : "transparent",
          ...(focus ? { WebkitBackdropFilter: "blur(12px)", backdropFilter: "blur(12px)" } : null),
        }}
        onClick={() => {
          if (take()) onClose();
        }}
        data-testid={`${testId}-backdrop`}
        data-dim={focus ? "1" : undefined}
      />
      {focus && lifted ? (
        <div
          ref={liftHost}
          aria-hidden
          className="fixed pointer-events-none"
          data-testid={`${testId}-lifted`}
          style={{
            zIndex: z + 1,
            left: lifted.rect.left,
            top: lifted.rect.top - placed.shift,
            width: lifted.rect.width,
            ...(liftSurface
              ? { background: fill, borderRadius: 14, boxShadow: "0 10px 28px var(--color-shadow)", overflow: "hidden" }
              : null),
          }}
        />
      ) : null}
      {floated && placed.head ? (
        <div
          className="zen-glass zen-glass-pill fixed flex items-center"
          role="menu"
          aria-label={`${label}: react`}
          data-testid={`${testId}-head`}
          style={{
            zIndex: z + 2,
            top: placed.head.top,
            left: place.left,
            right: place.left === undefined ? place.right : undefined,
            width: MENU_W,
            height: headPx,
            padding: "0 6px",
            color: "var(--color-text-primary)",
            ...material,
          }}
        >
          <div className="w-full">{head?.(take)}</div>
        </div>
      ) : null}
      <div
        role="menu"
        aria-label={label}
        className="zen-glass fixed"
        data-testid={testId}
        data-lifted={focus ? "1" : undefined}
        style={{
          zIndex: z + 2,
          ...place,
          width: MENU_W,
          overflowY: "auto",
          borderRadius: 16,
          padding: 6,
          color: "var(--color-text-primary)",
          ...material,
        }}
      >
        {head && !floated ? head(take) : null}
        {entries.map((e) =>
          isMute(e) ? (
            <MuteMenuItems
              key="mute"
              serverId={e.mute.serverId}
              rowRef={e.mute.rowRef}
              onDone={onClose}
              guard={take}
            />
          ) : (
            <button
              key={e.key}
              type="button"
              role="menuitem"
              aria-disabled={e.disabled || undefined}
              className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
              style={{
                gap: 10,
                padding: "10px 12px",
                minHeight: ITEM_H,
                borderRadius: 10,
                color: e.danger ? REMOVE_RED : "var(--color-text-primary)",
                opacity: e.disabled ? 0.45 : 1,
              }}
              data-testid={`menu-${e.key}`}
              onClick={() => {
                if (e.disabled || !take()) return;
                onClose();
                e.onSelect();
              }}
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate">{e.label}</span>
                {e.note ? (
                  <span className="block text-[13px]" style={{ color: "var(--color-text-muted)", whiteSpace: "normal" }} data-testid={`menu-${e.key}-note`}>
                    {e.note}
                  </span>
                ) : null}
              </span>
              {e.icon ? (
                <span aria-hidden className="flex shrink-0">
                  {e.icon}
                </span>
              ) : null}
            </button>
          )
        )}
      </div>
    </div>
  );
  // Lifted: over every pane (the Home chat is its own fixed layer), in
  // the app's font.
  return focus && typeof document !== "undefined"
    ? createPortal(<div style={{ fontFamily: "var(--zen-font)" }}>{body}</div>, document.body)
    : body;
}

const glyph = (children: ReactNode, testId?: string) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    data-testid={testId}
  >
    {children}
  </svg>
);

/** lucide "pin" / "pin-off", in the menu's plain icon colour like Open,
 *  Call and Rearrange (K2 Design, 4.3.0: only Remove is coloured). */
export function PinGlyph({ off }: { off: boolean }) {
  return (
    <span className="flex">
      {glyph(
        off ? (
          <>
            <path d="M12 17v5" />
            <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
            <path d="m2 2 20 20" />
            <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
          </>
        ) : (
          <>
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </>
        ),
        off ? "unpin-glyph" : "pin-glyph"
      )}
    </span>
  );
}

/** lucide "folders": Move to group…. */
export function GroupGlyph({ color }: { color?: string | null }) {
  return (
    <span className="flex" style={{ color: color || "var(--color-text-primary)" }}>
      {glyph(
        <>
          <path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z" />
          <path d="M2 8v11a2 2 0 0 0 2 2h14" />
        </>,
        "group-glyph"
      )}
    </span>
  );
}

/** lucide "arrow-up-down": Rearrange. */
export function RearrangeGlyph() {
  return glyph(
    <>
      <path d="m21 16-4 4-4-4" />
      <path d="M17 20V4" />
      <path d="m3 8 4-4 4 4" />
      <path d="M7 4v16" />
    </>
  );
}

/** lucide "message-circle": Open. */
export function OpenGlyph() {
  return glyph(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />);
}

/** lucide "house": Move to Home…. */
export function MoveHomeGlyph() {
  return glyph(
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>,
    "move-home-glyph"
  );
}

/** lucide "circle-minus": Remove from Home. */
export function RemoveGlyph() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
    </>
  );
}
