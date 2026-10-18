import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ClipboardEvent,
  type FocusEventHandler,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { filesFromClipboard } from "./composerAttach";
import { appendRef } from "./fileTreeModel";
import { useFileDrag } from "./fileDrag";
import { zenTextPx } from "./zenFont";
import { PlusGlyph } from "./PlusGlyph";
import { sidecarSuffix } from "./sidecarRows";

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
  field.style.height = "auto";
  const h = composerHeight(field.scrollHeight);
  field.style.height = `${h}px`;
  if (bar) bar.style.minHeight = held;
  return h;
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

export interface GlassComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Form submit (send bubble tap). The caller owns all send gating. */
  onSubmit: () => void;
  /** Files picked from `＋` or pasted. `＋` renders while `canSend`;
   *  disable it with `attachDisabled`. */
  onAttach?: (files: File[]) => void;
  placeholder?: string;
  /** Textarea disabled. */
  disabled?: boolean;
  /** Show `＋` and the send bubble (the thread hides both when it can't send). */
  canSend: boolean;
  /** Send bubble active (blue) — otherwise grey and disabled. */
  sendReady: boolean;
  attachDisabled?: boolean;
  /** Rows above the field (label, chips, errors). */
  children?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onFocus?: FocusEventHandler<HTMLTextAreaElement>;
  ariaLabel?: string;
  /** Test-id prefix: `${p}-bar`, `-form`, `-file-input`, `-field`,
   *  `-attach`, `-input`, `-send`. */
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
  /** The whole composer block's height (px): rows above the field,
   *  drawer room, the field, and the bar's safe-area / keyboard gap.
   *  Reported on mount and on every resize (ResizeObserver). */
  onBlockHeight?: (px: number) => void;
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
  placeholder = "Message",
  disabled,
  canSend,
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
  onBlockHeight,
}: GlassComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ref = textareaRef ?? ownRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const id = (s: string) => `${testIdPrefix}-${s}`;
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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitComposerField(el, barRef.current);
  }, [value, ref]);

  const blockCb = useRef(onBlockHeight);
  blockCb.current = onBlockHeight;
  const watchBlock = Boolean(onBlockHeight);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !watchBlock) return;
    let last = -1;
    const report = () => {
      const px = bar.offsetHeight;
      if (px === last) return;
      last = px;
      blockCb.current?.(px);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(bar);
    return () => ro.disconnect();
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
      className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2 zen-composer-bar"
      // A drawer stands above the bar: let it show.
      style={drawer ? { overflow: "visible" } : undefined}
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
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid={id("file-input")}
          onChange={(e) => {
            const list = e.target.files;
            onAttach?.(list ? Array.from(list) : []);
            e.target.value = "";
          }}
        />
        <div className="relative flex-1 min-w-0" data-testid={id("dock")}>
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
                  right: COMPOSER_DRAWER_INSET_PX,
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
          <div
            className="relative w-full min-w-0 overflow-hidden flex items-end gap-1 pl-1 pr-1 py-1 k2-tile"
            data-testid={id("field")}
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
            {canSend ? (
              <button
                type="button"
                data-testid={id("attach")}
                aria-label="Add file"
                disabled={Boolean(attachDisabled)}
                // Keep the textarea focused: a blur here drops the keyboard,
                // the composer slides down mid-tap and the click misses the
                // button, so the picker never opened. iOS dismisses the
                // keyboard itself when the picker presents.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
                className="shrink-0 flex items-center justify-center bg-transparent border-0 text-[var(--text-muted)] disabled:opacity-40"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                }}
              >
                <PlusGlyph />
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
              className={`flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[var(--text)] outline-none py-1 placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis ${canSend ? "" : "px-2"}`}
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
                type="submit"
                aria-label="Send"
                data-testid={id("send")}
                disabled={!sendReady}
                // Keep focus in the textarea so the iOS keyboard stays up
                // (AccessoryBar pattern). Attach does the same (see above).
                onPointerDown={(e) => e.preventDefault()}
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
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.75"
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
