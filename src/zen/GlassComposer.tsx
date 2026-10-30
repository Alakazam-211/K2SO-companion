import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
  type FocusEventHandler,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { filesFromClipboard, snapshotFiles } from "./composerAttach";
import { appendRef } from "./fileTreeModel";
import { useFileDrag } from "./fileDrag";
import { ZEN_TEXT_SCALE_VAR, zenTextPx } from "./zenFont";
import { PlusGlyph } from "./PlusGlyph";
import { sidecarSuffix } from "./sidecarRows";
import { AttachMenu, type AttachChoice, type AttachMenuExtra } from "./AttachMenu";
import { alongCurve, curveEasing, flyMotion, prefersReducedMotion } from "./sendFly";
import { usePressSpring } from "../lib/usePressSpring";
import {
  isUnsupportedPick,
  nativePick,
  nativePickerAvailable,
  skippedMessage,
} from "../lib/nativePicker";

/** Composer placeholder: "Message <Agent>", "Message <Agent>/<sidecar>"
 *  on an extra chat, "Message <group>" on a project chat, else "Message".
 *  The sidecar part is the addr suffix (`k2/reviewer` → `reviewer`), not a
 *  renamed title; `sidecar` is the fallback when the addr is the main one
 *  (a terminal opened from the Sessions drawer carries only its title). */
export function composerPlaceholder(
  row:
    | {
        name?: string | null;
        addr?: string | null;
        kind?: string | null;
        sidecar?: string | null;
      }
    | null
    | undefined
): string {
  const name = (row?.name || "").trim();
  if (!name || name === "—") return "Message";
  if (row?.kind === "group") return `Message ${name}`;
  const suffix =
    sidecarSuffix((row?.addr || "").trim()).trim() || (row?.sidecar || "").trim();
  return suffix ? `Message ${name}/${suffix}` : `Message ${name}`;
}

/** iMessage grows the field then caps (~5 lines) and scrolls inside. */
export const COMPOSER_MAX_PX = 132;

export function composerHeight(scrollHeight: number, maxPx = COMPOSER_MAX_PX): number {
  if (!Number.isFinite(scrollHeight) || scrollHeight < 24) return 24;
  return Math.min(scrollHeight, maxPx);
}

/** Re-fit the auto-growing field to its text without the bar ever
 *  collapsing. Measuring sets the textarea to `auto` (one row) and reads
 *  its scrollHeight, which forces a layout with the bar a few lines
 *  shorter: the column above (the Thread scroller, the terminal) grows
 *  for that layout and the browser clamps its scrollTop — then the bar
 *  regrows and the newest lines sit under the field with no resize left
 *  to notice. Holding the bar at its current height while measuring
 *  keeps the column's box still. */
export function fitComposerField(field: HTMLTextAreaElement, bar: HTMLElement | null): number {
  const held = bar ? bar.style.minHeight : "";
  if (bar) bar.style.minHeight = `${bar.offsetHeight}px`;
  // Measuring at `auto` resets the field's own scroll to the top; at the
  // max height that left the caret below the visible lines (two returns
  // and you had to scroll the field yourself). Keep the caret in view.
  const scrolled = field.scrollTop;
  field.style.height = "auto";
  const h = composerHeight(field.scrollHeight);
  field.style.height = `${h}px`;
  if (bar) bar.style.minHeight = held;
  keepCaretInView(field, scrolled);
  return h;
}

/** The field's line height (px), read from computed style once per field
 *  and text size (Settings → Text Size rescales it), not on every input. */
const lineHeights = new WeakMap<HTMLElement, { key: string; px: number }>();
function fieldLineHeight(field: HTMLTextAreaElement): number {
  let scale = "";
  try {
    scale = document.documentElement.style.getPropertyValue(ZEN_TEXT_SCALE_VAR);
  } catch {
    scale = "";
  }
  const key = `${scale}|${field.style.lineHeight}`;
  const hit = lineHeights.get(field);
  if (hit && hit.key === key) return hit.px;
  let px = 22;
  try {
    px = parseFloat(getComputedStyle(field).lineHeight) || 22;
  } catch {
    px = 22;
  }
  lineHeights.set(field, { key, px });
  return px;
}

/** After a refit: a caret at the end of the text (typing, a return) shows
 *  the last line; otherwise the field keeps its scroll, moved just enough
 *  to show the caret's line (estimated by newlines; wrapped lines are
 *  close enough for a scroll that only has to reveal it). */
export function keepCaretInView(field: HTMLTextAreaElement, scrolled: number): void {
  if (field.scrollHeight <= field.clientHeight + 1) return;
  const focused = typeof document !== "undefined" && document.activeElement === field;
  const end = field.selectionEnd ?? field.value.length;
  if (focused && end >= field.value.length) {
    field.scrollTop = field.scrollHeight;
    return;
  }
  field.scrollTop = scrolled;
  if (!focused) return;
  const line = fieldLineHeight(field);
  const caretTop = (field.value.slice(0, end).split("\n").length - 1) * line;
  if (caretTop < field.scrollTop) field.scrollTop = caretTop;
  else if (caretTop + line > field.scrollTop + field.clientHeight) {
    field.scrollTop = caretTop + line - field.clientHeight;
  }
}

/** Set on the textarea while a send's clear eases it shut: its final
 *  height (px). `settledHeight` reads past the animation with it. */
export const SETTLED_HEIGHT_ATTR = "data-settled-height";

/** A composer block's height once any clear-collapse inside it is done:
 *  what the list's bottom padding must be NOW, so the sent bubble is
 *  aimed at its final slot while the field still eases down over it. */
export function settledHeight(block: HTMLElement): number {
  const fields = block.querySelectorAll<HTMLElement>(`[${SETTLED_HEIGHT_ATTR}]`);
  if (!fields.length) return block.offsetHeight;
  let h = block.getBoundingClientRect().height;
  fields.forEach((f) => {
    const settled = parseFloat(f.getAttribute(SETTLED_HEIGHT_ATTR) ?? "");
    if (Number.isFinite(settled)) h -= Math.max(0, f.getBoundingClientRect().height - settled);
  });
  return Math.round(h);
}

/** The block's height above its bottom padding (the home-indicator /
 *  keyboard gap), settled like `settledHeight`. The Thread pads for that
 *  gap with its own spacer (index.css), so this stays put while the
 *  bar's padding eases with the keyboard (no per-frame reports). */
export function composerBlockHeight(block: HTMLElement): number {
  let pad = 0;
  try {
    pad = parseFloat(getComputedStyle(block).paddingBottom) || 0;
  } catch {
    pad = 0;
  }
  if (!(pad > 0)) return settledHeight(block);
  let h = block.getBoundingClientRect().height - pad;
  block.querySelectorAll<HTMLElement>(`[${SETTLED_HEIGHT_ATTR}]`).forEach((f) => {
    const settled = parseFloat(f.getAttribute(SETTLED_HEIGHT_ATTR) ?? "");
    if (Number.isFinite(settled)) h -= Math.max(0, f.getBoundingClientRect().height - settled);
  });
  return Math.max(0, Math.round(h));
}

/** The field's corner radius (px). The drawer's geometry derives from it. */
export const COMPOSER_RADIUS_PX = 20;
/** Drawer side inset: half the radius, so its sides land on the field's
 *  top edge about halfway round the corner curve. */
export const COMPOSER_DRAWER_INSET_PX = COMPOSER_RADIUS_PX * 0.5;
/** The drawer's own top-corner radius. */
export const COMPOSER_DRAWER_RADIUS_PX = COMPOSER_RADIUS_PX * 0.75;
/** How far the drawer tucks behind the field's top edge: deep enough that
 *  its square bottom corners reach under the curve at the inset (the
 *  curve drops r − √(r² − inset²) there), plus 1px of seam. */
export const COMPOSER_DRAWER_TUCK_PX =
  Math.ceil(
    COMPOSER_RADIUS_PX -
      Math.sqrt(COMPOSER_RADIUS_PX ** 2 - (COMPOSER_RADIUS_PX - COMPOSER_DRAWER_INSET_PX) ** 2)
  ) + 1;
/** Headroom above the drawer inside its clip box (the slide's overshoot). */
const DRAWER_HEADROOM_PX = 12;
/** Between the drawer and the tab beside it. */
export const DRAWER_ASIDE_GAP_PX = 6;

export interface GlassComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Form submit (send bubble tap). The caller owns all send gating. */
  onSubmit: () => void;
  /** Files picked from `＋` or pasted. `＋` renders while `canSend`;
   *  disable it with `attachDisabled`. */
  onAttach?: (files: File[]) => void;
  /** A pick that left files out (too large, unreadable) or failed. */
  onAttachError?: (message: string) => void;
  placeholder?: string;
  /** Textarea disabled. */
  disabled?: boolean;
  /** Show `＋` and the send bubble (the thread hides both when it can't send). */
  canSend: boolean;
  /** Offer `＋` at all (default true). A ticket comment is text only. */
  attach?: boolean;
  /** Send bubble active (blue) — otherwise grey and disabled. */
  sendReady: boolean;
  attachDisabled?: boolean;
  /** Rows above the field (label, chips, errors). */
  children?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onFocus?: FocusEventHandler<HTMLTextAreaElement>;
  ariaLabel?: string;
  /** Test-id prefix: `${p}-bar`, `-form`, `-file-input`, `-photo-input`,
   *  `-camera-input`, `-field`, `-attach`, `-attach-menu`, `-input`,
   *  `-send`. */
  testIdPrefix?: string;
  /** Extra attrs on the bar (e.g. `data-k2-variant`). */
  barProps?: Record<string, string | undefined>;
  /** A drawer docked on the field's top edge: flush, inset by half the
   *  radius each side, tucked behind the field so it slides out of it. It
   *  floats above the bar (the caller pads whatever it covers). Its tile
   *  reads `--k2-drawer-radius` / `--k2-drawer-tuck` from the slot. */
  drawer?: ReactNode;
  /** Room (px) kept between `children` and the field so rows above the
   *  field are not covered by the drawer. 0 when there are none. */
  drawerRoom?: number;
  /** A tab docked on the field's top edge at the right, beside the
   *  drawer (the Thread's stash button), `drawerAsideWidth` px wide. The
   *  drawer leaves it that much room plus a gap. */
  drawerAside?: ReactNode;
  drawerAsideWidth?: number;
  /** Rows the `＋` menu offers below the attach choices (the Thread's
   *  "Save to stash"). With these, `＋` opens even when `attachDisabled`:
   *  the menu then holds only them. A row's tap closes the menu first. */
  menuExtras?: AttachMenuExtra[];
  /** The composer block's height (px) above its bottom gap: rows above
   *  the field, drawer room, the field (composerBlockHeight). The bar's
   *  safe-area / keyboard gap is left out: the Thread's spacer pads for it
   *  (index.css `.zen-thread-pane`). Reported on mount and on every resize (ResizeObserver), settled
   *  (a clear-collapse in progress reports its end height). */
  onBlockHeight?: (px: number) => void;
  /** A send clearing a multi-line draft may ease the field shut on the
   *  send flight's curve — only when the DEV `collapse` override asks for
   *  it. By default a send snaps the field to one empty line in the same
   *  commit (iMessage: the placeholder is back on the next frame). */
  smoothClear?: boolean;
}

/** The Zen glass composer: one full-width rounded tile field holding a
 *  borderless `＋`, the auto-growing textarea and a round send bubble
 *  (grey → #0a84ff). Presentational — ThreadPane and the Zen terminal
 *  page own what attach and send do. */
export function GlassComposer({
  value,
  onChange,
  onSubmit,
  onAttach,
  onAttachError,
  placeholder = "Message",
  disabled,
  canSend,
  attach = true,
  sendReady,
  attachDisabled,
  children,
  textareaRef,
  onFocus,
  ariaLabel,
  testIdPrefix = "composer",
  barProps,
  drawer,
  drawerRoom = 0,
  drawerAside,
  drawerAsideWidth = 0,
  menuExtras,
  onBlockHeight,
  smoothClear = false,
}: GlassComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ref = textareaRef ?? ownRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const id = (s: string) => `${testIdPrefix}-${s}`;
  const showAttach = canSend && attach;

  // `＋` opens our own menu (AttachMenu), not iOS's file-input menu, so
  // the keyboard stays up while choosing. The pickers themselves still
  // take the screen (and the keyboard); `refocus` brings the field back
  // when one returns if it had focus when the menu opened.
  const [menuOpen, setMenuOpen] = useState(false);
  const [plusPressed, setPlusPressed] = useState(false);
  const refocus = useRef(false);
  const hasExtras = !!menuExtras?.length;
  const plusDisabled = Boolean(attachDisabled) && !hasExtras;
  const menuShown = menuOpen && showAttach && !plusDisabled;
  const plusLit = (plusPressed || menuShown) && !plusDisabled;
  const closeMenu = useCallback(() => {
    refocus.current = false;
    setMenuOpen(false);
  }, []);
  // Disabled or hidden while open: it stays closed when `＋` comes back.
  useEffect(() => {
    if (!showAttach || plusDisabled) setMenuOpen(false);
  }, [showAttach, plusDisabled]);
  const restoreFocus = useCallback(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const el = ref.current;
    if (!el || el.disabled) return;
    // A presented picker ends the input session without a DOM blur:
    // focus() on the still-active field would be a no-op.
    if (document.activeElement === el) el.blur();
    el.focus({ preventScroll: true });
  }, [ref]);
  const deliver = (files: File[]) => {
    if (files.length) onAttach?.(files);
  };
  const pickWithInput = (choice: AttachChoice) => {
    const input =
      choice === "camera" ? cameraRef.current : choice === "library" ? photoRef.current : fileRef.current;
    input?.click();
  };
  const choose = (choice: AttachChoice) => {
    setMenuOpen(false);
    // The camera input opens the camera directly (no iOS menu).
    if (choice === "camera" || !nativePickerAvailable()) {
      pickWithInput(choice);
      return;
    }
    nativePick(choice === "library" ? "media" : "documents")
      .then((out) => {
        deliver(out.files);
        const skipped = skippedMessage(out.skipped);
        if (skipped) onAttachError?.(skipped);
      })
      .catch((e) => {
        if (isUnsupportedPick(e)) {
          pickWithInput(choice);
          return;
        }
        console.warn("[attach] native picker failed:", e);
        onAttachError?.("Could not open the picker.");
      })
      .finally(restoreFocus);
  };
  // The web inputs: `change` on a pick, `cancel` (Safari 16.4+) on close.
  useEffect(() => {
    const inputs = [fileRef.current, photoRef.current, cameraRef.current];
    for (const el of inputs) el?.addEventListener("cancel", restoreFocus);
    return () => {
      for (const el of inputs) el?.removeEventListener("cancel", restoreFocus);
    };
  }, [restoreFocus]);
  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const picked = input.files ? Array.from(input.files) : [];
    restoreFocus();
    if (!picked.length) return;
    // Read the bytes before the input is cleared (snapshotFiles).
    void snapshotFiles(picked).then(({ files, unreadable }) => {
      input.value = "";
      if (files.length) onAttach?.(files);
      if (unreadable.length) onAttachError?.(`Could not read ${unreadable.join(", ")}`);
    });
  };
  // Files drawer drag: the field is the drop target. A drop (or a
  // direct insert) queues a file reference; this composer appends it.
  const dragging = useFileDrag((s) => s.drag !== null);
  const dropHot = useFileDrag((s) => s.overComposer);
  const pendingInsert = useFileDrag((s) => s.pendingInsert);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    if (!pendingInsert) return;
    useFileDrag.getState().takeInsert(pendingInsert.seq);
    latest.current.onChange(appendRef(latest.current.value, pendingInsert.text));
  }, [pendingInsert]);

  // The clear-collapse (smoothClear) in flight, and the last value fitted.
  const collapse = useRef<Animation | null>(null);
  const fittedValue = useRef(value);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Typing again mid-collapse: measure the real field, not the ease.
    if (collapse.current) {
      const anim = collapse.current;
      collapse.current = null;
      anim.cancel();
    }
    el.removeAttribute(SETTLED_HEIGHT_ATTR);
    const before = parseFloat(el.style.height);
    const cleared = value === "" && fittedValue.current !== "";
    fittedValue.current = value;
    const h = fitComposerField(el, barRef.current);
    if (
      !smoothClear ||
      !cleared ||
      !(before > h + 0.5) ||
      typeof el.animate !== "function" ||
      prefersReducedMotion()
    ) {
      return;
    }
    const motion = flyMotion();
    if (!motion.collapse) return;
    // Same duration and curve as the bubble leaving it. Its parent reads
    // the end height through `settledHeight` (the list pads for it now).
    el.setAttribute(SETTLED_HEIGHT_ATTR, String(h));
    let anim: Animation;
    try {
      anim = el.animate(
        alongCurve(motion, (p) => ({ height: `${Math.round((before + (h - before) * p) * 100) / 100}px` })),
        { duration: motion.ms, easing: curveEasing(motion) }
      );
    } catch {
      el.removeAttribute(SETTLED_HEIGHT_ATTR);
      return;
    }
    collapse.current = anim;
    const end = () => {
      if (collapse.current !== anim) return;
      collapse.current = null;
      el.removeAttribute(SETTLED_HEIGHT_ATTR);
    };
    anim.onfinish = end;
    anim.oncancel = end;
  }, [value, ref, smoothClear]);
  useEffect(() => () => collapse.current?.cancel(), []);

  const [sendPressed, setSendPressed] = useState(false);
  // Send also grows while pressed (with its brighten; Rosson 2026-10-23).
  const pressSend = usePressSpring<HTMLButtonElement>();
  const blockCb = useRef(onBlockHeight);
  blockCb.current = onBlockHeight;
  const watchBlock = Boolean(onBlockHeight);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !watchBlock) return;
    let last = -1;
    const report = () => {
      const px = composerBlockHeight(bar);
      if (px === last) return;
      last = px;
      blockCb.current?.(px);
    };
    report();
    // The bar's bottom padding (home-indicator inset at rest, 8px while
    // typing) is not counted (composerBlockHeight): the Thread's spacer
    // eases with it. Watch the border box anyway (top padding, rows), and
    // re-read on focus moves as a backstop.
    const refocus = () => requestAnimationFrame(report);
    bar.addEventListener("focusin", refocus);
    bar.addEventListener("focusout", refocus);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(report);
      ro.observe(bar, { box: "border-box" });
    }
    return () => {
      ro?.disconnect();
      bar.removeEventListener("focusin", refocus);
      bar.removeEventListener("focusout", refocus);
    };
  }, [watchBlock]);

  const onPasteFiles = (e: ClipboardEvent) => {
    if (!onAttach) return;
    const files = filesFromClipboard(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    onAttach(files);
  };

  return (
    // zen-composer-bar: home-indicator inset at rest, collapsed while
    // typing so it is not a gap above the keyboard (.input-bar idiom).
    <div
      ref={barRef}
      className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2 zen-composer-bar mchat-bar"
      // A drawer or the attach menu stands above the bar: let it show.
      style={drawer || drawerAside || menuShown ? { overflow: "visible" } : undefined}
      data-testid={id("bar")}
      {...barProps}
    >
      {children}
      {drawer && drawerRoom > 0 ? (
        <div aria-hidden="true" data-testid={id("drawer-room")} style={{ height: Math.ceil(drawerRoom) }} />
      ) : null}
      <form
        className="flex items-end min-w-0"
        data-testid={id("form")}
        onPaste={onPasteFiles}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {/* Web pickers: Choose Files (any type), Photo Library when the
            native one is missing, and the camera (capture: no iOS menu). */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid={id("file-input")}
          onChange={onInputChange}
        />
        <input
          ref={photoRef}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          data-testid={id("photo-input")}
          onChange={onInputChange}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          className="hidden"
          data-testid={id("camera-input")}
          onChange={onInputChange}
        />
        <div className="relative flex-1 min-w-0" data-testid={id("dock")}>
          {drawerAside ? (
            // Same clip box as the drawer's, at the right.
            <div
              data-testid={id("drawer-aside")}
              className="absolute overflow-hidden pointer-events-none"
              style={
                {
                  right: COMPOSER_DRAWER_INSET_PX,
                  width: drawerAsideWidth,
                  bottom: `calc(100% - ${COMPOSER_DRAWER_TUCK_PX}px)`,
                  paddingTop: DRAWER_HEADROOM_PX,
                  zIndex: 0,
                  "--k2-drawer-radius": `${COMPOSER_DRAWER_RADIUS_PX}px`,
                  "--k2-drawer-tuck": `${COMPOSER_DRAWER_TUCK_PX}px`,
                } as CSSProperties
              }
            >
              {drawerAside}
            </div>
          ) : null}
          {drawer ? (
            // Clip box: its bottom edge sits `tuck` px under the field's
            // top, so the drawer slides out from behind the field (which
            // stacks above it) and its seam is the field's top rim.
            <div
              data-testid={id("drawer")}
              className="absolute overflow-hidden pointer-events-none"
              style={
                {
                  left: COMPOSER_DRAWER_INSET_PX,
                  right: COMPOSER_DRAWER_INSET_PX + (drawerAside ? drawerAsideWidth + DRAWER_ASIDE_GAP_PX : 0),
                  bottom: `calc(100% - ${COMPOSER_DRAWER_TUCK_PX}px)`,
                  paddingTop: DRAWER_HEADROOM_PX,
                  zIndex: 0,
                  "--k2-drawer-radius": `${COMPOSER_DRAWER_RADIUS_PX}px`,
                  "--k2-drawer-tuck": `${COMPOSER_DRAWER_TUCK_PX}px`,
                } as CSSProperties
              }
            >
              {drawer}
            </div>
          ) : null}
          {menuShown ? (
            <AttachMenu
              onChoose={choose}
              onClose={closeMenu}
              anchorRef={plusRef}
              testIdPrefix={testIdPrefix}
              files={!attachDisabled}
              extras={menuExtras?.map((x) => ({
                ...x,
                onSelect: () => {
                  closeMenu();
                  x.onSelect();
                },
              }))}
            />
          ) : null}
          <div
            className="relative w-full min-w-0 overflow-hidden flex items-end gap-1 pl-1 pr-1 py-1 k2-tile"
            data-testid={id("field")}
            // The send flight's first frame is this pill (sendFly).
            data-composer-field=""
            data-k2-drop="composer"
            data-drop-target={dragging ? (dropHot ? "hot" : "armed") : undefined}
            style={{
              borderRadius: COMPOSER_RADIUS_PX,
              zIndex: 1,
              ...(dragging
                ? {
                    boxShadow: dropHot
                      ? "0 0 0 2px #0a84ff, 0 0 18px rgba(10,132,255,0.45)"
                      : "0 0 0 1px rgba(10,132,255,0.55)",
                    transition: "box-shadow 120ms ease",
                  }
                : {}),
            }}
          >
            {showAttach ? (
              <button
                ref={plusRef}
                type="button"
                data-testid={id("attach")}
                aria-label="Add file"
                aria-haspopup="menu"
                aria-expanded={menuShown}
                disabled={plusDisabled}
                // Keep the textarea focused: a blur here drops the keyboard,
                // the composer slides down mid-tap and the click misses the
                // button. The menu opens with the keyboard still up.
                onPointerDown={(e) => {
                  e.preventDefault();
                  if (!plusDisabled) setPlusPressed(true);
                }}
                onPointerUp={() => setPlusPressed(false)}
                onPointerCancel={() => setPlusPressed(false)}
                onPointerLeave={() => setPlusPressed(false)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!menuShown) refocus.current = document.activeElement === ref.current;
                  setMenuOpen(!menuShown);
                }}
                className="shrink-0 flex items-center justify-center bg-transparent border-0 text-[var(--text-muted)] disabled:opacity-40"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  // Lit while pressed and while its menu is open.
                  background: plusLit ? "rgba(255,255,255,0.2)" : undefined,
                  transition: "background-color 90ms ease-out",
                }}
                data-lit={plusLit || undefined}
              >
                <PlusGlyph bright={plusLit} />
              </button>
            ) : null}
            <textarea
              ref={ref}
              disabled={disabled}
              value={value}
              rows={1}
              onChange={(e) => onChange(e.target.value)}
              onFocus={onFocus}
              onPaste={onPasteFiles}
              placeholder={placeholder}
              className={`flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[var(--text)] outline-none py-1 placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis ${showAttach ? "" : "px-2"}`}
              style={{
                maxHeight: COMPOSER_MAX_PX,
                fontSize: zenTextPx(17),
                lineHeight: zenTextPx(22),
              }}
              aria-label={ariaLabel ?? placeholder}
              data-testid={id("input")}
            />
            {canSend ? (
              <button
                ref={pressSend}
                type="submit"
                aria-label="Send"
                data-testid={id("send")}
                disabled={!sendReady}
                // Keep focus in the textarea so the iOS keyboard stays up
                // (AccessoryBar pattern). Attach does the same (see above).
                onPointerDown={(e) => {
                  e.preventDefault();
                  if (sendReady) setSendPressed(true);
                }}
                onPointerUp={() => setSendPressed(false)}
                onPointerCancel={() => setSendPressed(false)}
                onPointerLeave={() => setSendPressed(false)}
                onMouseDown={(e) => e.preventDefault()}
                className={`shrink-0 flex items-center justify-center k2-tile ${
                  sendReady
                    ? "text-white"
                    : "k2-tile-raised text-[var(--text-muted)] opacity-60"
                }`}
                style={{
                  // A short pill, 8px wider than the + (Rosson 2026-10-17).
                  width: 38,
                  height: 30,
                  borderRadius: 15,
                  ...(sendReady
                    ? { background: "#0a84ff", borderColor: "#0a84ff" }
                    : {}),
                  // Pressed: a little brighter (Rosson 2026-10-18). preventDefault
                  // above keeps the keyboard up but also skips :active on iOS.
                  filter: sendPressed && sendReady ? "brightness(1.5)" : undefined,
                  transition: "filter 90ms ease-out",
                }}
              >
                <svg
                  width="21"
                  height="21"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}
