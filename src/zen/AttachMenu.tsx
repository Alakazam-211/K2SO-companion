import { useEffect, useRef, type ComponentType, type RefObject, type SyntheticEvent } from "react";
import { useBackHandler } from "../lib/androidBack";
import { CameraIcon, FolderIcon, PhotoIcon, type IconProps } from "./icons";
import { paletteById } from "../theme/palettes";
import { useThemeStore } from "../theme/themeStore";

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

/** The camera row while a voice call is up: video would take the call's
 *  microphone, so the camera takes photos only. */
export const CAMERA_PHOTO_ONLY_LABEL = "Take Photo";

export const ATTACH_MENU_RADIUS_PX = 22;
export const ATTACH_MENU_ROW_PX = 44;

/** A glass menu's fill (attach, More). On a dark palette: darker than the
 *  plain glass so the labels read over the thread (iOS's menu material; no
 *  palette token is this dark and see-through). On a light one: Veil's own
 *  frost, so its dark words read. `dark`: a menu's own dark fill. */
export const MENU_GLASS_DARK = "rgba(36, 36, 40, 0.62)";
export function useMenuGlassFill(dark: string = MENU_GLASS_DARK): string {
  const light = useThemeStore((s) => paletteById(s.shown)?.scheme === "light");
  return light ? "var(--color-frost-fill)" : dark;
}

/** The menu material at its full fill: solid, so nothing behind reads
 *  through it (a lifted hold menu over a dimmed page; K2 Design 4.3.0).
 *  The raised tone on a dark palette (iOS's dark menu), the card white on
 *  a light one. */
export function useMenuSolidFill(): string {
  const light = useThemeStore((s) => paletteById(s.shown)?.scheme === "light");
  return light ? "var(--color-bg-surface)" : "var(--color-bg-elevated)";
}

/** Keep the textarea focused: a blur drops the iOS keyboard (send pattern). */
const keepFocus = (e: SyntheticEvent) => e.preventDefault();

/**
 * The composer's own attach menu, in place of iOS's file-input menu
 * (which dismisses the keyboard). A glass popover anchored above the
 * `＋`, opening upward from its corner. Nothing inside takes focus, so
 * the keyboard stays up while it is open. Tap outside, Escape or Android
 * Back closes it. `extras` follow the attach choices under a hairline;
 * `files: false` leaves the attach choices out (attaching is off here).
 * `photoOnly`: the camera row offers photos only (a voice call is up).
 */
export function AttachMenu({
  onChoose,
  onClose,
  anchorRef,
  testIdPrefix = "composer",
  extras = [],
  files = true,
  photoOnly = false,
}: {
  onChoose: (choice: AttachChoice) => void;
  onClose: () => void;
  /** The `＋`: a tap on it toggles, so it is not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  testIdPrefix?: string;
  extras?: AttachMenuExtra[];
  files?: boolean;
  photoOnly?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useBackHandler(true, () => close.current());
  const fill = useMenuGlassFill();

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
        color: "var(--color-text-primary)",
        background: fill,
      }}
    >
      {(files ? ATTACH_MENU_ITEMS : []).map(({ choice, label, Icon }) => (
        <MenuRow
          key={choice}
          testId={`${testIdPrefix}-attach-${choice}`}
          label={choice === "camera" && photoOnly ? CAMERA_PHOTO_ONLY_LABEL : label}
          Icon={Icon}
          onClick={() => onChoose(choice)}
        />
      ))}
      {files && extras.length ? (
        <div role="separator" style={{ height: 0.5, margin: "6px 16px", background: "var(--color-wash-3)" }} />
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
        color: "var(--color-text-primary)",
        fontSize: 17,
        lineHeight: "22px",
      }}
    >
      <Icon size={22} strokeWidth={1.7} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
