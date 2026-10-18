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

export const ATTACH_MENU_RADIUS_PX = 22;
export const ATTACH_MENU_ROW_PX = 44;

/** Keep the textarea focused: a blur drops the iOS keyboard (send pattern). */
const keepFocus = (e: SyntheticEvent) => e.preventDefault();

/**
 * The composer's own attach menu, in place of iOS's file-input menu
 * (which dismisses the keyboard). A glass popover anchored above the
 * `＋`, opening upward from its corner. Nothing inside takes focus, so
 * the keyboard stays up while it is open. Tap outside, Escape or Android
 * Back closes it.
 */
export function AttachMenu({
  onChoose,
  onClose,
  anchorRef,
  testIdPrefix = "composer",
}: {
  onChoose: (choice: AttachChoice) => void;
  onClose: () => void;
  /** The `＋`: a tap on it toggles, so it is not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  testIdPrefix?: string;
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
      {ATTACH_MENU_ITEMS.map(({ choice, label, Icon }) => (
        <button
          key={choice}
          type="button"
          role="menuitem"
          data-testid={`${testIdPrefix}-attach-${choice}`}
          className="w-full flex items-center text-left bg-transparent border-0"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => onChoose(choice)}
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
      ))}
    </div>
  );
}
