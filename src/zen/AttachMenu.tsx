import { useEffect, useRef, type ComponentType, type RefObject, type SyntheticEvent } from "react";
import { useBackHandler } from "../lib/androidBack";
import { CameraIcon, FolderIcon, PhotoIcon, type IconProps } from "./icons";

/** The attach menu's choices, top to bottom. */
export type AttachChoice = "library" | "camera" | "files";

export const ATTACH_MENU_ITEMS: {
  choice: AttachChoice;
  label: string;
  Icon: ComponentType<IconProps>;
}[] = [
  { choice: "library", label: "Photo Library", Icon: PhotoIcon },
  { choice: "camera", label: "Take Photo or Video", Icon: CameraIcon },
  { choice: "files", label: "Choose Files", Icon: FolderIcon },
];

/** A menu row the page adds below the attach choices (the Thread's
 *  "Save to stash"). */
export type AttachMenuExtra = {
  key: string;
  label: string;
  Icon: ComponentType<IconProps>;
  onSelect: () => void;
  /** Shown dimmed, takes no tap (nothing to save yet). */
  disabled?: boolean;
};

export const ATTACH_MENU_RADIUS_PX = 22;
export const ATTACH_MENU_ROW_PX = 44;

/** Keep the textarea focused: a blur drops the iOS keyboard (send pattern). */
const keepFocus = (e: SyntheticEvent) => e.preventDefault();

/**
 * The composer's own attach menu, in place of iOS's file-input menu
 * (which dismisses the keyboard). A glass popover anchored above the
 * `＋`, opening upward from its corner. Nothing inside takes focus, so
 * the keyboard stays up while it is open. Tap outside, Escape or Android
 * Back closes it. `extras` follow the attach choices under a hairline;
 * `files: false` leaves the attach choices out (attaching is off here).
 */
export function AttachMenu({
  onChoose,
  onClose,
  anchorRef,
  testIdPrefix = "composer",
  extras = [],
  files = true,
}: {
  onChoose: (choice: AttachChoice) => void;
  onClose: () => void;
  /** The `＋`: a tap on it toggles, so it is not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  testIdPrefix?: string;
  extras?: AttachMenuExtra[];
  files?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useBackHandler(true, () => close.current());

  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close.current();
    };
    // Capture: a tap anywhere else closes it without being swallowed, so
    // a tap on the field keeps typing and a tap on the thread scrolls.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorRef]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Attach"
      className="zen-glass k2-attach-menu absolute"
      data-testid={`${testIdPrefix}-attach-menu`}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      style={{
        left: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 40,
        width: "min(250px, calc(100vw - 32px))",
        borderRadius: ATTACH_MENU_RADIUS_PX,
        padding: "6px 0",
        color: "#fff",
        // Darker than the plain glass so the labels read over the thread.
        background: "rgba(36, 36, 40, 0.62)",
      }}
    >
      {(files ? ATTACH_MENU_ITEMS : []).map(({ choice, label, Icon }) => (
        <MenuRow
          key={choice}
          testId={`${testIdPrefix}-attach-${choice}`}
          label={label}
          Icon={Icon}
          onClick={() => onChoose(choice)}
        />
      ))}
      {files && extras.length ? (
        <div role="separator" style={{ height: 0.5, margin: "6px 16px", background: "rgba(255,255,255,0.18)" }} />
      ) : null}
      {extras.map(({ key, label, Icon, onSelect, disabled }) => (
        <MenuRow
          key={key}
          testId={`${testIdPrefix}-menu-${key}`}
          label={label}
          Icon={Icon}
          disabled={disabled}
          onClick={onSelect}
        />
      ))}
    </div>
  );
}

function MenuRow({
  testId,
  label,
  Icon,
  disabled,
  onClick,
}: {
  testId: string;
  label: string;
  Icon: ComponentType<IconProps>;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className="w-full flex items-center text-left bg-transparent border-0 disabled:opacity-40"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
      style={{
        gap: 12,
        minHeight: ATTACH_MENU_ROW_PX,
        padding: "0 16px",
        color: "#fff",
        fontSize: 17,
        lineHeight: "22px",
      }}
    >
      <Icon size={22} strokeWidth={1.7} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
