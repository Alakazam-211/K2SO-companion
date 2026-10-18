// iMessage-style send (frame-matched to a 30 fps recording of iMessage):
// - Frame 1: the WHOLE composer field (its pill, padding and all) is a
//   faint translucent blue bubble in place; the real field is already
//   empty, one line, placeholder showing (no eased collapse).
// - First ~quarter: the blue goes solid while the shape shrinks in width
//   toward the right edge (an outgoing bubble) and starts rising; the
//   field's text blurs a little and crossfades to the bubble's line breaks.
// - Then it glides into its slot, the list sliding up in sync, and lands
//   with a ~2 px settle (an under-damped spring). ~420 ms in all.
//
// How (WKWebView):
// - The bubble's resting rect is measured ONCE, before the list glide
//   starts (so it is glide-free). Nothing reads rects per frame.
// - Two layers, both sampled on one curve (flyMotion), started in the
//   same frame as the list glide (same duration and curve):
//   * the SHAPE: a blue box anchored at its bottom-right corner. Its
//     position is a compositor translate3d; its size (field → bubble,
//     corner radius field → bubble) is a clip-path inset with round
//     corners, so the pill ends never distort (a non-uniform scale would
//     squash them). The tail (if the bubble has one) rides the anchor.
//   * the TEXT: a transparent clone of the bubble, translate3d + uniform
//     scale (letters keep their shape) from the field's text origin to
//     the bubble's; a "ghost" of the field's text (its font and line
//     breaks) blurs and fades out while the bubble's own text un-blurs in.
// - Opacity / transform / filter on the layers, plus the shape's clip.
//   will-change only while flying.
// - At the end, one rect read: if the real bubble moved mid-flight (the
//   working drawer, a landing), it slides the last few px itself.
//
// DEV tuning on the phone (debug builds only, ignored in production):
//   localStorage.setItem("k2.debug.sendFly", JSON.stringify({ ms: 420,
//     easing: "spring(0.85)", blueAt: 0.25, blueFrom: 0.25, textAt: 0.3,
//     blurPx: 1.5, collapse: false }))
// `easing` is "spring", "spring(<damping ratio 0.3–1>)" or any CSS easing
// ("cubic-bezier(0.22, 1, 0.36, 1)"). `collapse: true` brings back the old
// eased composer collapse for an A/B. Read on every send: no rebuild or
// reload. Remove the key to go back to the defaults below.

export type FlyRect = { left: number; top: number; width: number; height: number };

/** The composer field's text as drawn at Send (the clone's first frame). */
export type FlyGhost = {
  text: string;
  /** The field's text box (content box) size, px. */
  width: number;
  height: number;
  scrollTop: number;
  fontPx: number;
  lineHeightPx: number;
  letterSpacingPx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  whiteSpace: string;
  overflowWrap: string;
  wordBreak: string;
};

/** The composer at Send: where its text box sat and how big it was
 *  drawn (and, for a text field, the text itself as laid out there), and
 *  the field pill around it (the blue's first frame). */
export type FlySource = {
  rect: FlyRect;
  fontPx: number;
  ghost?: FlyGhost | null;
  /** The whole composer field (its rounded pill, padding included). */
  field?: { rect: FlyRect; radius: number } | null;
};

export type FlyMotion = {
  /** Flight (and list glide) duration. */
  ms: number;
  /** "spring", "spring(<zeta>)" or a CSS easing. Shared by every part. */
  easing: string;
  /** Fraction of the flight by which the bubble's blue is solid. */
  blueAt: number;
  /** The blue's opacity on the first frame (a faint tint over the field). */
  blueFrom: number;
  /** Fraction of the flight by which the field's text has crossfaded to
   *  the bubble's. */
  textAt: number;
  /** The text's blur at the crossfade's midpoint, px. */
  blurPx: number;
  /** Ease the composer's own collapse (a multi-line draft) too. Off: the
   *  field snaps to one empty line in the Send commit (iMessage). */
  collapse: boolean;
};

/** iMessage's send is ~0.42 s from tap to settled (13 frames at 30 fps). */
export const FLY_MS = 420;
/** Slightly under-damped: ~0.6% overshoot, i.e. a ~2 px settle on a
 *  typical 300 px flight (iMessage's soft landing). Baked into keyframes
 *  (linear between) and shared with the list glide. */
export const FLY_EASING = "spring(0.85)";
/** The blue is solid a quarter of the way through… */
export const FLY_BLUE_AT = 0.25;
/** …starting from a faint translucent tint over the field on frame 1. */
export const FLY_BLUE_FROM = 0.25;
/** The text keeps the composer look for the first ~30% (re-wrapping). */
export const FLY_TEXT_AT = 0.3;
/** A soft blur while the text re-wraps (filter: compositor in WebKit). */
export const FLY_TEXT_BLUR_PX = 1.5;
/** The end correction when the real bubble moved mid-flight. */
export const FLY_CORRECT_MS = 180;
/** A bubble delivered mid-flight brightens after the reveal (matches
 *  useDeliverBrighten's DELIVER_BRIGHTEN_MS). */
export const FLY_BRIGHTEN_MS = 500;
/** Spring decay rate per flight (zeta * omega): ~99.7% there at the end. */
export const SPRING_DECAY = 8;
/** The clone's stacking: the pane root is not a stacking context, so this
 *  competes with the column's composer dock (2) and header (10). */
export const FLY_Z = 5;
/** DEV-only override key (see the header). */
export const SEND_FLY_DEBUG_KEY = "k2.debug.sendFly";

const SOFT_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Bubble padding (Bubble's `px-3 py-2`) when it cannot be read. */
const PAD_X = 12;
const PAD_Y = 8;

export const DEFAULT_FLY_MOTION: Readonly<FlyMotion> = Object.freeze({
  ms: FLY_MS,
  easing: FLY_EASING,
  blueAt: FLY_BLUE_AT,
  blueFrom: FLY_BLUE_FROM,
  textAt: FLY_TEXT_AT,
  blurPx: FLY_TEXT_BLUR_PX,
  collapse: false,
});

export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** "spring" → 1, "spring(0.8)" → 0.8, anything else → null. */
export function springDamping(easing: string): number | null {
  const m = /^\s*spring\s*(?:\(\s*([0-9.]+)\s*\))?\s*$/i.exec(easing);
  if (!m) return null;
  const z = m[1] == null ? 1 : parseFloat(m[1]);
  return Number.isFinite(z) ? Math.min(Math.max(z, 0.3), 1) : null;
}

function validEasing(easing: string): boolean {
  if (springDamping(easing) != null) return true;
  try {
    if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
      return CSS.supports("transition-timing-function", easing);
    }
  } catch {
    return false;
  }
  return easing.trim() !== "";
}

/** The send motion: the constants above, or (DEV builds only) the
 *  `k2.debug.sendFly` override. Read per send so a tweak applies at once. */
export function flyMotion(): FlyMotion {
  const base: FlyMotion = { ...DEFAULT_FLY_MOTION };
  if (!import.meta.env.DEV) return base;
  try {
    const raw = window.localStorage.getItem(SEND_FLY_DEBUG_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw) as Partial<Record<keyof FlyMotion, unknown>> | null;
    if (!o || typeof o !== "object") return base;
    if (typeof o.ms === "number" && o.ms >= 80 && o.ms <= 3000) base.ms = o.ms;
    if (typeof o.easing === "string" && validEasing(o.easing)) base.easing = o.easing;
    if (typeof o.blueAt === "number" && o.blueAt >= 0.05 && o.blueAt <= 1) base.blueAt = o.blueAt;
    if (typeof o.blueFrom === "number" && o.blueFrom >= 0 && o.blueFrom <= 1) base.blueFrom = o.blueFrom;
    if (typeof o.textAt === "number" && o.textAt >= 0.05 && o.textAt <= 1) base.textAt = o.textAt;
    if (typeof o.blurPx === "number" && o.blurPx >= 0 && o.blurPx <= 8) base.blurPx = o.blurPx;
    if (typeof o.collapse === "boolean") base.collapse = o.collapse;
    return base;
  } catch {
    return base;
  }
}

/** A damped spring released from rest, at time `t` (0–1 of the flight),
 *  normalised so it is exactly 0 at the start and 1 at the end. */
export function springProgress(t: number, zeta = 1): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  const x = (u: number) => {
    if (zeta >= 1) {
      const w = SPRING_DECAY;
      return 1 - (1 + w * u) * Math.exp(-w * u);
    }
    const w = SPRING_DECAY / zeta;
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w * u) * (Math.cos(wd * u) + ((zeta * w) / wd) * Math.sin(wd * u));
  };
  return x(t) / x(1);
}

/** The effect easing for keyframes built by `alongCurve`. */
export function curveEasing(motion: FlyMotion): string {
  return springDamping(motion.easing) == null ? motion.easing : "linear";
}

/** Keyframes along the motion's curve: `frame(p)` for progress p. A spring
 *  is sampled (~one keyframe a frame, linear between: Core Animation runs
 *  it as one keyframe animation); a CSS easing is just its two ends. */
export function alongCurve(motion: FlyMotion, frame: (p: number) => Keyframe): Keyframe[] {
  const zeta = springDamping(motion.easing);
  if (zeta == null) return [frame(0), frame(1)];
  const n = Math.max(12, Math.round(motion.ms / 16));
  const out: Keyframe[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ ...frame(springProgress(t, zeta)), offset: t });
  }
  return out;
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;

export function rectOf(el: Element | null | undefined): FlyRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function fontPxOf(el: Element | null | undefined): number {
  if (!el || typeof getComputedStyle !== "function") return NaN;
  return parseFloat(getComputedStyle(el).fontSize);
}

const num = (v: string | undefined | null, fallback = 0) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};

/** The FLIP "first" for a text field, read once at Send before it clears:
 *  its text box (inside padding and border, minus its own scroll) and the
 *  text as drawn there. */
/** The composer field pill a text field sits in (GlassComposer marks it
 *  `data-composer-field`): its rect and corner radius. */
export const COMPOSER_FIELD_ATTR = "data-composer-field";

export function fieldPillOf(field: Element | null | undefined): { rect: FlyRect; radius: number } | null {
  const pill = field?.closest(`[${COMPOSER_FIELD_ATTR}]`) ?? null;
  const rect = rectOf(pill);
  if (!pill || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const cs = getComputedStyle(pill);
  const radius =
    num(cs.borderTopLeftRadius) || num((pill as HTMLElement).style?.borderRadius) || rect.height / 2;
  return { rect, radius: Math.min(radius, rect.height / 2, rect.width / 2) };
}

export function flySourceOfField(field: HTMLTextAreaElement | null | undefined): FlySource | null {
  const r = rectOf(field);
  if (!field || !r) return null;
  const cs = getComputedStyle(field);
  const padL = num(cs.paddingLeft) + num(cs.borderLeftWidth);
  const padT = num(cs.paddingTop) + num(cs.borderTopWidth);
  const padR = num(cs.paddingRight) + num(cs.borderRightWidth);
  const padB = num(cs.paddingBottom) + num(cs.borderBottomWidth);
  const fontPx = num(cs.fontSize, 17);
  const width = Math.max(0, r.width - padL - padR);
  const height = Math.max(0, r.height - padT - padB);
  return {
    rect: { left: r.left + padL, top: r.top + padT, width, height },
    fontPx,
    field: fieldPillOf(field),
    ghost: {
      text: field.value,
      width,
      height,
      scrollTop: field.scrollTop || 0,
      fontPx,
      lineHeightPx: num(cs.lineHeight, fontPx * 1.2),
      letterSpacingPx: num(cs.letterSpacing),
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      color: cs.color,
      whiteSpace: cs.whiteSpace || "pre-wrap",
      overflowWrap: cs.overflowWrap,
      wordBreak: cs.wordBreak,
    },
  };
}

function clampScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, 0.5), 2) : 1;
}

/** Transform keyframes taking the bubble (laid out at `to`) from the
 *  composer text at `from` back to itself: a uniform scale (composer font
 *  / bubble font, so letters keep their shape) and a translate that puts
 *  the bubble's text origin (`pad` inside it) on the composer's. Transform
 *  only: compositor work. */
export function flyKeyframes(
  from: FlyRect,
  to: FlyRect,
  scale: number,
  motion: FlyMotion = DEFAULT_FLY_MOTION,
  pad: { x: number; y: number } = { x: PAD_X, y: PAD_Y }
): Keyframe[] {
  const s = clampScale(scale);
  const dx = from.left - to.left - pad.x * s;
  const dy = from.top - to.top - pad.y * s;
  return alongCurve(motion, (p) => ({
    transform: `translate3d(${px(dx * (1 - p))}, ${px(dy * (1 - p))}, 0px) scale(${
      Math.round((s + (1 - s) * p) * 10000) / 10000
    })`,
  }));
}

/** The list makes room for the new row: it was laid out (and stuck to
 *  the newest) with the row in it, which moved the messages above by
 *  `dy` in one frame (up for the new row; down when a multi-line composer
 *  shrank more than that). Start them `dy` back and glide them home on
 *  the bubble's curve. Layout is untouched (a transform), so scrolling and
 *  the bubble's final rect stay true. Returns a cancel. */
export function glideList(
  content: HTMLElement | null,
  dy: number,
  motion: FlyMotion = flyMotion()
): () => void {
  if (!content || !(Math.abs(dy) >= 1) || typeof content.animate !== "function") return () => {};
  content.style.willChange = "transform";
  const clear = () => {
    content.style.willChange = "";
  };
  let anim: Animation;
  try {
    anim = content.animate(
      alongCurve(motion, (p) => ({ transform: `translate3d(0px, ${px(dy * (1 - p))}, 0px)` })),
      { duration: motion.ms, easing: curveEasing(motion) }
    );
  } catch {
    clear();
    return () => {};
  }
  anim.onfinish = clear;
  anim.oncancel = clear;
  return () => {
    try {
      anim.cancel();
    } catch {
      /* already gone */
    }
    clear();
  };
}

/** The blue shape's flight from the field pill (`from`) to the bubble
 *  (`to`), all in the same coordinates. The box is the larger of the two,
 *  anchored at the bubble's bottom-right corner (so it shrinks toward the
 *  right edge, like an outgoing bubble). Its position rides a translate3d
 *  (compositor); its size and corner radius ride a clip-path inset with
 *  round corners (never a non-uniform scale: the pill ends keep their
 *  shape). Exported for tests: `visibleAt(p)` is the rect it draws. */
export function shapeFlight(
  from: FlyRect,
  to: FlyRect,
  radius: { from: number; to: number },
  motion: FlyMotion = DEFAULT_FLY_MOTION
): {
  box: FlyRect;
  move: Keyframe[];
  clip: Keyframe[];
  visibleAt: (p: number) => FlyRect;
} {
  const W = Math.max(from.width, to.width);
  const H = Math.max(from.height, to.height);
  const right = to.left + to.width;
  const bottom = to.top + to.height;
  const box = { left: right - W, top: bottom - H, width: W, height: H };
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
  const visibleAt = (p: number): FlyRect => {
    const w = lerp(from.width, to.width, p);
    const h = lerp(from.height, to.height, p);
    const r = lerp(from.left + from.width, right, p);
    const b = lerp(from.top + from.height, bottom, p);
    return { left: r - w, top: b - h, width: w, height: h };
  };
  const dx = from.left + from.width - right;
  const dy = from.top + from.height - bottom;
  const move = alongCurve(motion, (p) => ({
    transform: `translate3d(${px(dx * (1 - p))}, ${px(dy * (1 - p))}, 0px)`,
  }));
  const clip = alongCurve(motion, (p) => {
    const w = lerp(from.width, to.width, p);
    const h = lerp(from.height, to.height, p);
    const r = Math.max(0, Math.min(lerp(radius.from, radius.to, p), w / 2, h / 2));
    return {
      clipPath: `inset(${px(Math.max(0, H - h))} 0px 0px ${px(Math.max(0, W - w))} round ${px(r)})`,
    };
  });
  return { box, move, clip, visibleAt };
}

function clipPathSupported(): boolean {
  try {
    return (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("clip-path", "inset(1px 0px 0px 1px round 4px)")
    );
  } catch {
    return false;
  }
}

/** Fly the text into `bubble` from `source` inside `root` (the pane:
 *  positioned, so the layers share its CSS variables and stack above the
 *  composer dock and its footer blur). `glide` moves the list on the same
 *  curve, started after the bubble's resting rect is measured. `target`
 *  finds the real bubble at the end (default: `bubble`). Reveals it and
 *  calls `done` once, after the motion — or at once when it cannot run.
 *  Returns a cancel (the glide too). */
export function runSendFly(opts: {
  root: HTMLElement;
  bubble: HTMLElement;
  source: FlySource;
  done: () => void;
  target?: () => HTMLElement | null;
  /** `run`: start the glide through the caller's own list controller
   *  (`listGlide`), so it folds into any glide already running. */
  glide?: {
    content: HTMLElement | null;
    dy: number;
    run?: (dy: number, motion: FlyMotion) => () => void;
  };
  motion?: FlyMotion;
}): () => void {
  const { root, bubble, source, done } = opts;
  const motion = opts.motion ?? flyMotion();
  let finished = false;
  let layers: HTMLElement[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopGlide = () => {};
  const real = (): HTMLElement | null => {
    const el = opts.target?.() ?? null;
    if (el) return el;
    return bubble.isConnected ? bubble : null;
  };
  // The resting rect, read once, BEFORE the glide moves the list.
  const to = rectOf(bubble);
  const base = rectOf(root);
  let endOpacity = 1;
  const finish = (landed: boolean) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    // Reveal the real bubble in the same step the layers go (React's own
    // re-render to un-hide it can land a frame later: never a blank frame).
    const el = real();
    if (el) {
      el.style.visibility = "";
      if (landed && to && base) settle(el, root, to, base, endOpacity);
    }
    for (const l of layers) l.remove();
    layers = [];
    done();
  };
  const cancel = () => {
    stopGlide();
    finish(false);
  };
  if (!to || !base || typeof bubble.animate !== "function") {
    finish(false);
    return cancel;
  }
  try {
    const cs = getComputedStyle(bubble);
    const pad = { x: num(cs.paddingLeft, PAD_X), y: num(cs.paddingTop, PAD_Y) };
    endOpacity = num(bubble.style.opacity || cs.opacity, 1);
    const blue = cs.backgroundColor || "rgb(10, 132, 255)";
    const bubbleRadius = num(cs.borderTopLeftRadius) || num(bubble.style.borderRadius) || 18;
    const bubbleFont = fontPxOf(bubble.querySelector(".chat-markdown") ?? bubble);
    const s = clampScale(source.fontPx / bubbleFont);
    const timing = { duration: motion.ms, fill: "both" as const };
    const blueAt = Math.min(Math.max(motion.blueAt, 0.05), 1);
    const textAt = Math.min(Math.max(motion.textAt, 0.05), 1);
    const blur = Math.max(0, motion.blurPx);
    const tail = bubble.getAttribute("data-tail");
    const rel = (r: FlyRect): FlyRect => ({ ...r, left: r.left - base.left, top: r.top - base.top });
    const layerStyle = {
      position: "absolute",
      margin: "0",
      pointerEvents: "none",
      // Above the composer dock (z 2) and its footer blur the whole way;
      // under the floating header (z 10) and side panes, exactly where the
      // real bubble paints: no pop at the hand-off.
      zIndex: String(FLY_Z),
      transition: "none",
    } satisfies Partial<CSSStyleDeclaration>;

    // ── The shape: the field pill on frame 1, the bubble at the end. ──
    const fromShape = source.field ?? { rect: source.rect, radius: bubbleRadius };
    const flight = shapeFlight(rel(fromShape.rect), rel(to), { from: fromShape.radius, to: bubbleRadius }, motion);
    const shape = document.createElement("div");
    shape.setAttribute("data-testid", "send-fly-shape");
    shape.setAttribute("aria-hidden", "true");
    Object.assign(shape.style, {
      ...layerStyle,
      left: `${flight.box.left}px`,
      top: `${flight.box.top}px`,
      width: `${flight.box.width}px`,
      height: `${flight.box.height}px`,
      willChange: "transform, opacity",
      opacity: String(motion.blueFrom),
    } satisfies Partial<CSSStyleDeclaration>);
    const fill = document.createElement("div");
    fill.setAttribute("data-fly-part", "backdrop");
    Object.assign(fill.style, {
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      background: blue,
    } satisfies Partial<CSSStyleDeclaration>);
    shape.appendChild(fill);
    let tailEl: HTMLElement | null = null;
    if (tail) {
      // The real bubble's tail (chatBubbles.css), riding the bottom-right
      // anchor; it grows in as the shape becomes a bubble.
      tailEl = document.createElement("div");
      tailEl.setAttribute("data-fly-part", "tail");
      tailEl.className = "zen-tail-solo";
      tailEl.setAttribute("data-tail", tail);
      tailEl.style.setProperty("--k2-bubble", blue);
      shape.appendChild(tailEl);
    }

    // ── The text: a transparent clone of the bubble (its own line
    // breaks), and the field's text as drawn (the ghost). ──
    const clone = bubble.cloneNode(true) as HTMLElement;
    clone.setAttribute("data-testid", "send-fly-clone");
    clone.removeAttribute("data-fly-target");
    clone.removeAttribute("data-tail");
    clone.classList.remove("zen-tail");
    clone.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.setAttribute("data-fly-part", "body");
    while (clone.firstChild) body.appendChild(clone.firstChild);
    clone.appendChild(body);
    Object.assign(clone.style, {
      ...layerStyle,
      left: `${to.left - base.left}px`,
      top: `${to.top - base.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
      maxWidth: "none",
      boxSizing: "border-box",
      visibility: "visible",
      transformOrigin: "0 0",
      willChange: "transform, opacity",
      background: "transparent",
      overflow: "visible",
      opacity: "1",
    } satisfies Partial<CSSStyleDeclaration>);
    // The composer's text exactly as the field drew it: counter-scaled so
    // that at the clone's first frame (scale s) it is the field's font,
    // line height and line breaks, at the field's text origin.
    let ghost: HTMLElement | null = null;
    const g = source.ghost;
    if (g && g.text.trim()) {
      ghost = document.createElement("div");
      ghost.setAttribute("data-fly-part", "ghost");
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${pad.x}px`,
        top: `${pad.y}px`,
        width: `${g.width / s}px`,
        height: `${g.height / s}px`,
        overflow: "hidden",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      const text = document.createElement("div");
      Object.assign(text.style, {
        position: "relative",
        top: `${-g.scrollTop / s}px`,
        margin: "0",
        padding: "0",
        fontFamily: g.fontFamily,
        fontWeight: g.fontWeight,
        fontStyle: g.fontStyle,
        fontSize: `${g.fontPx / s}px`,
        lineHeight: `${g.lineHeightPx / s}px`,
        letterSpacing: `${g.letterSpacingPx / s}px`,
        color: g.color,
        whiteSpace: g.whiteSpace,
        overflowWrap: g.overflowWrap,
        wordBreak: g.wordBreak,
        textAlign: "left",
      } satisfies Partial<CSSStyleDeclaration>);
      text.textContent = g.text;
      ghost.appendChild(text);
      clone.appendChild(ghost);
    }
    root.appendChild(shape);
    root.appendChild(clone);
    layers = [shape, clone];
    // The list starts moving in the same frame as the layers, on their curve.
    const gl = opts.glide;
    stopGlide = gl ? (gl.run ? gl.run(gl.dy, motion) : glideList(gl.content, gl.dy, motion)) : () => {};

    const fly = clone.animate(flyKeyframes(source.rect, to, s, motion, pad), {
      ...timing,
      easing: curveEasing(motion),
    });
    shape.animate(flight.move, { ...timing, easing: curveEasing(motion) });
    if (clipPathSupported()) {
      fill.animate(flight.clip, { ...timing, easing: curveEasing(motion) });
    } else {
      // Old WebKit: no animatable clip-path. The fill is the bubble's box
      // and a scale takes it from the field's (the ends squash a little).
      const v0 = flight.visibleAt(0);
      Object.assign(fill.style, {
        left: "auto",
        top: "auto",
        width: `${to.width}px`,
        height: `${to.height}px`,
        borderRadius: `${bubbleRadius}px`,
        transformOrigin: "100% 100%",
      } satisfies Partial<CSSStyleDeclaration>);
      fill.animate(
        alongCurve(motion, (p) => {
          const sx = (v0.width + (to.width - v0.width) * p) / Math.max(1, to.width);
          const sy = (v0.height + (to.height - v0.height) * p) / Math.max(1, to.height);
          return { transform: `scale(${Math.round(sx * 10000) / 10000}, ${Math.round(sy * 10000) / 10000})` };
        }),
        { ...timing, easing: curveEasing(motion) }
      );
    }
    // Blue from a faint tint over the field, solid early (ease-out), held;
    // then the bubble's own "Sending…" opacity, like the text.
    shape.animate(
      [
        { opacity: motion.blueFrom, offset: 0, easing: "ease-out" },
        { opacity: endOpacity, offset: blueAt },
        { opacity: endOpacity, offset: 1 },
      ],
      { ...timing, easing: "linear" }
    );
    tailEl?.animate(
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: Math.min(blueAt, 0.2), easing: "ease-out" },
        { opacity: 1, offset: Math.min(0.6, Math.max(blueAt, 0.2) + 0.3) },
        { opacity: 1, offset: 1 },
      ],
      { ...timing, easing: "linear" }
    );
    // Composer-bright text → the bubble's "Sending…" opacity, with the blue.
    clone.animate(
      [
        { opacity: 1, offset: 0, easing: "ease-out" },
        { opacity: endOpacity, offset: blueAt },
        { opacity: endOpacity, offset: 1 },
      ],
      { ...timing, easing: "linear" }
    );
    if (ghost) {
      // The field's text softens and goes as the bubble's sharpens in.
      const half = Math.round(textAt * 500) / 1000;
      ghost.animate(
        [
          { opacity: 1, filter: "blur(0px)", offset: 0, easing: "ease-in" },
          { opacity: 0.5, filter: `blur(${blur}px)`, offset: half },
          { opacity: 0, filter: `blur(${blur}px)`, offset: textAt },
          { opacity: 0, filter: `blur(${blur}px)`, offset: 1 },
        ],
        { ...timing, easing: "linear" }
      );
      body.animate(
        [
          { opacity: 0, filter: `blur(${blur}px)`, offset: 0, easing: "ease-out" },
          { opacity: 0.5, filter: `blur(${blur}px)`, offset: half },
          { opacity: 1, filter: "blur(0px)", offset: textAt },
          { opacity: 1, filter: "blur(0px)", offset: 1 },
        ],
        { ...timing, easing: "linear" }
      );
    }
    fly.onfinish = () => finish(true);
    fly.oncancel = () => finish(false);
  } catch {
    cancel();
    return cancel;
  }
  // A backgrounded WebView may never fire finish: never leave it hidden.
  timer = setTimeout(() => finish(true), motion.ms + 400);
  return cancel;
}

/** The hand-off. One rect read (plus the root's): if the real bubble moved while the clone
 *  flew (the working drawer opening, a landing), it slides the last few px
 *  itself. Delivered mid-flight: it brightens from the clone's dim. */
function settle(
  el: HTMLElement,
  root: HTMLElement,
  to: FlyRect,
  base: FlyRect,
  fromOpacity: number
) {
  if (typeof el.animate !== "function") return;
  const now = rectOf(el);
  // Root-relative: the clone sat in the root, which may itself have moved.
  const rootNow = rectOf(root) ?? base;
  if (now) {
    const dx = to.left - base.left - (now.left - rootNow.left);
    const dy = to.top - base.top - (now.top - rootNow.top);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      el.animate(
        [{ transform: `translate3d(${px(dx)}, ${px(dy)}, 0px)` }, { transform: "translate3d(0px, 0px, 0px)" }],
        { duration: FLY_CORRECT_MS, easing: SOFT_OUT }
      );
    }
  }
  const target = num(el.style.opacity, 1);
  if (Math.abs(target - fromOpacity) > 0.01) {
    el.animate([{ opacity: fromOpacity }, { opacity: target }], {
      duration: FLY_BRIGHTEN_MS,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });
  }
}
