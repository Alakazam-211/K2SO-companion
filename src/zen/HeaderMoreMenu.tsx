import { useEffect, useRef, type ComponentType, type RefObject } from "react";
import { useBackHandler } from "../lib/androidBack";
import type { TicketScope, TicketsBadge } from "../api/feedbackPure";
import { MoreIcon, type IconProps } from "./icons";

/** The in-call green (iOS system green): the Rooms row and the More dot. */
export const IN_CALL_GREEN = "#30d158";
/** iMessage unread blue: project chats. */
export const PROJECTS_BLUE = "#0a84ff";
/** Tickets keep amber, whichever count they show. */
export const TICKETS_AMBER = "#f59e0b";

export const MORE_MENU_RADIUS_PX = 22;
export const MORE_MENU_ROW_PX = 44;

/** A count pill on a menu row (and, summed, on the More button). */
export type MoreBadge = {
  count: number;
  background: string;
  color: string;
  testId: string;
  /** Lands on `data-tone` (the Tickets badge's mine/others). */
  tone?: string;
};

/** One row of the More menu. */
export type HeaderMoreItem = {
  key: string;
  label: string;
  /** Accessible name when it says more than the label (Tickets counts). */
  ariaLabel?: string;
  Icon: ComponentType<IconProps>;
  iconTestId?: string;
  /** The row's tint (Rooms turns green in a call). */
  color?: string;
  badge?: MoreBadge | null;
  testId: string;
  onSelect: () => void;
};

export const badgeText = (n: number): string => (n > 99 ? "99+" : String(n));

/** The More button's badge: project chats unread plus the Tickets count.
 *  Amber when tickets are in it (they wait on someone), else blue. */
export function moreBadge(
  projectsUnread: number,
  tickets: TicketsBadge | null
): { count: number; tone: "tickets" | "projects" } | null {
  const count = Math.max(0, projectsUnread) + (tickets?.count ?? 0);
  if (count === 0) return null;
  return { count, tone: tickets ? "tickets" : "projects" };
}

/** "More, in a call, 2 project chats unread, 1 ticket waiting on you". */
export function moreAriaLabel({
  inCall,
  projectsUnread,
  tickets,
}: {
  inCall: boolean;
  projectsUnread: number;
  tickets: Record<TicketScope, number>;
}): string {
  const parts = ["More"];
  if (inCall) parts.push("in a call");
  if (projectsUnread > 0) {
    parts.push(`${projectsUnread} project ${projectsUnread === 1 ? "chat" : "chats"} unread`);
  }
  const t = tickets.waiting > 0 ? tickets.waiting : tickets.all;
  if (t > 0) {
    const noun = t === 1 ? "ticket" : "tickets";
    parts.push(tickets.waiting > 0 ? `${t} ${noun} waiting on you` : `${t} ${noun} waiting`);
  }
  return parts.join(", ");
}

/**
 * The Agents header's one right-hand button: three dots in the same 34px
 * glass circle the four buttons had. The summed badge sits top right; a
 * green dot bottom right while a voice call is up, so both read without
 * opening the menu.
 */
export function HeaderMoreButton({
  open,
  onToggle,
  inCall,
  badge,
  ariaLabel,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  inCall: boolean;
  badge: { count: number; tone: "tickets" | "projects" } | null;
  ariaLabel: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="relative flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
      style={{ width: 34, height: 34, color: "#fff" }}
      onClick={onToggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      title="More"
      data-testid="chats-header-more"
    >
      <MoreIcon size={18} strokeWidth={2.4} testId="more-icon" />
      {badge ? (
        <span
          className="absolute"
          aria-hidden
          data-testid="chats-header-more-badge"
          data-tone={badge.tone}
          style={{
            ...BADGE,
            top: -2,
            right: -2,
            background: badge.tone === "tickets" ? TICKETS_AMBER : PROJECTS_BLUE,
            color: badge.tone === "tickets" ? "#000" : "#fff",
          }}
        >
          {badgeText(badge.count)}
        </span>
      ) : null}
      {inCall ? (
        <span
          className="absolute"
          aria-hidden
          data-testid="chats-header-more-call"
          style={{
            bottom: 0,
            right: 0,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: IN_CALL_GREEN,
            // A dark rim so the dot reads over the glass.
            boxShadow: "0 0 0 1.5px #000",
          }}
        />
      ) : null}
    </button>
  );
}

const BADGE = {
  minWidth: 15,
  height: 15,
  padding: "0 4px",
  borderRadius: 8,
  fontSize: 9,
  fontWeight: 700,
  lineHeight: "15px",
  textAlign: "center",
} as const;

/**
 * The More menu: Rooms, Projects, Tickets and Settings, each with its old
 * icon, a plain label and its badge. The attach menu's dark glass and
 * grow-in, anchored under the button at the header's right edge. Tap
 * outside (the backdrop takes the tap, like the focus-group menu), Escape
 * or Android Back closes it; choosing a row closes it, then runs it.
 */
export function HeaderMoreMenu({
  items,
  onClose,
}: {
  items: HeaderMoreItem[];
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useBackHandler(true, () => close.current());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 bg-transparent border-0 p-0"
        style={{ zIndex: 29 }}
        data-no-pin="1"
        onClick={onClose}
        data-testid="chats-more-backdrop"
      />
      <div
        role="menu"
        aria-label="More"
        className="zen-glass k2-more-menu absolute"
        data-no-pin="1"
        data-testid="chats-more-menu"
        style={{
          zIndex: 30,
          // Under the 34px button: same top as the focus-group menu, same
          // 12px right edge as the header row.
          top: "calc(env(safe-area-inset-top) + 52px)",
          right: 12,
          width: "min(240px, calc(100vw - 24px))",
          maxHeight: "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 72px)",
          overflowY: "auto",
          borderRadius: MORE_MENU_RADIUS_PX,
          padding: "6px 0",
          color: "#fff",
          // Darker than the plain glass so the labels read over the list.
          background: "rgba(36, 36, 40, 0.62)",
        }}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            aria-label={item.ariaLabel}
            data-testid={item.testId}
            className="w-full flex items-center text-left bg-transparent border-0"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            style={{
              gap: 12,
              minHeight: MORE_MENU_ROW_PX,
              padding: "0 16px",
              color: item.color ?? "#fff",
              fontSize: 17,
              lineHeight: "22px",
            }}
          >
            <item.Icon size={22} strokeWidth={1.7} className="shrink-0" testId={item.iconTestId} />
            <span className="flex-1 min-w-0 truncate">{item.label}</span>
            {item.badge && item.badge.count > 0 ? (
              <span
                className="shrink-0"
                aria-hidden
                data-testid={item.badge.testId}
                data-tone={item.badge.tone}
                style={{
                  minWidth: 20,
                  height: 20,
                  padding: "0 6px",
                  borderRadius: 10,
                  background: item.badge.background,
                  color: item.badge.color,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "20px",
                  textAlign: "center",
                }}
              >
                {badgeText(item.badge.count)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}
