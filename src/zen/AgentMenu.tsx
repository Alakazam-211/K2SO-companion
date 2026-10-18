import { useEffect, useRef, type ReactNode } from "react";
import { useBackHandler } from "../lib/androidBack";
import type { RowRef } from "./unread";
import { MuteMenuItems } from "./UnreadMarks";
import type { HeldMenu, MenuRect } from "./useHoldMenu";

// The one press-and-hold menu for an agent (Agents rows, pinned avatars,
// Home rows). Every row action lives here: Open, Pin / Unpin, Mute,
// Move to group…, Rearrange, Remove from Home. Glass, iOS-style: label
// on the left, glyph on the right, under the pressed row (above it when
// there is no room below).

/** iOS system yellow, the Messages pin glyph. */
export const PIN_YELLOW = "#ffd60a";
const REMOVE_RED = "#ff453a";
const ITEM_H = 44;
const MENU_W = 220;

export type AgentMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
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
export function agentMenuPlacement(
  rect: MenuRect,
  count: number,
  align: "center" | "end",
  viewportH: number
): { top?: number; bottom?: number; left?: string; right?: number; maxHeight: number } {
  const h = count * ITEM_H + 12;
  const below = rect.bottom + 6;
  const fitsBelow = below + h <= viewportH - 16;
  const fitsAbove = rect.top - 6 - h >= 16;
  const x =
    align === "center"
      ? { left: `clamp(12px, ${rect.left + rect.width / 2}px - ${MENU_W / 2}px, calc(100vw - ${MENU_W + 12}px))` }
      : { right: 16 };
  if (!fitsBelow && fitsAbove) {
    return { ...x, bottom: viewportH - rect.top + 6, maxHeight: rect.top - 22 };
  }
  return { ...x, top: below, maxHeight: Math.max(ITEM_H * 2, viewportH - below - 16) };
}

export function AgentMenu({
  label,
  menu,
  entries,
  onClose,
  align = "end",
  testId = "agent-menu",
}: {
  /** The menu's accessible name (the agent's). */
  label: string;
  menu: HeldMenu;
  entries: AgentMenuEntry[];
  onClose: () => void;
  align?: "center" | "end";
  testId?: string;
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
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const place = agentMenuPlacement(menu.rect, entries.length, align, viewportH);
  return (
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
        className="fixed inset-0 bg-transparent border-0 p-0"
        style={{ zIndex: 29 }}
        onClick={() => {
          if (take()) onClose();
        }}
        data-testid={`${testId}-backdrop`}
      />
      <div
        role="menu"
        aria-label={label}
        className="zen-glass fixed"
        data-testid={testId}
        style={{
          zIndex: 30,
          ...place,
          width: MENU_W,
          overflowY: "auto",
          borderRadius: 16,
          padding: 6,
          color: "#fff",
        }}
      >
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
              className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
              style={{
                gap: 10,
                padding: "10px 12px",
                minHeight: ITEM_H,
                borderRadius: 10,
                color: e.danger ? REMOVE_RED : "#fff",
              }}
              data-testid={`menu-${e.key}`}
              onClick={() => {
                if (!take()) return;
                onClose();
                e.onSelect();
              }}
            >
              <span className="flex-1 min-w-0 truncate">{e.label}</span>
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

/** lucide "pin" / "pin-off". */
export function PinGlyph({ off }: { off: boolean }) {
  return (
    <span className="flex" style={{ color: PIN_YELLOW }}>
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
    <span className="flex" style={{ color: color || "#fff" }}>
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

/** lucide "circle-minus": Remove from Home. */
export function RemoveGlyph() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
    </>
  );
}
