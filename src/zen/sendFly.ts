// iMessage-style send: the text lifts out of the composer and flies into
// its outgoing bubble (FLIP). The real bubble is laid out at its final
// spot but hidden; a clone of it starts over the composer text and
// animates back to identity, then the real bubble is revealed.
//
// Smoothness rules (WKWebView):
// - The bubble's resting rect is measured ONCE, before the list glide
//   starts (so it is glide-free). The clone then runs a single
//   compositor-only transform (translate3d + scale) to it. No per-frame
//   rect reads or style writes: nothing chases a moving target.
// - The list glide and the clone share the exact duration and curve
//   (flyMotion), start in the same frame and land together.
// - Frame 0 is the composer text, pixel for pixel: a "ghost" of the
//   field's text (its font, line height, colour and line breaks, counter-
//   scaled inside the clone) sits exactly where the textarea drew it,
//   while the bubble's own text (its line breaks) crossfades in over a
//   few frames. The bubble's blue starts as a faint tint and ramps in
//   early (by `blueAt`), so the bubble never pops in late.
// - Opacity / transform only, on the clone's parts; will-change only
//   while flying.
// - At the end, one rect read: if the real bubble moved mid-flight (the
//   working drawer, a landing), it slides the last few px itself.
//
// DEV tuning on the phone (debug builds only, ignored in production):
//   localStorage.setItem("k2.debug.sendFly",
//     JSON.stringify({ ms: 480, easing: "spring", blueAt: 0.25, collapse: true }))
// `easing` is "spring", "spring(<damping ratio 0.3–1>)" or any CSS easing
// ("cubic-bezier(0.22, 1, 0.36, 1)"). Read on every send: no rebuild or
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

/** The composer text at Send: where its text box sat and how big it was
 *  drawn (and, for a text field, the text itself as laid out there). */
export type FlySource = { rect: FlyRect; fontPx: number; ghost?: FlyGhost | null };

export type FlyMotion = {
  /** Flight (and list glide, and composer collapse) duration. */
  ms: number;
  /** "spring", "spring(<zeta>)" or a CSS easing. Shared by every part. */
  easing: string;
  /** Fraction of the flight by which the bubble's blue is fully in. */
  blueAt: number;
  /** Ease the composer's own collapse (a multi-line draft) too. */
  collapse: boolean;
};

/** Calm on purpose: delivery takes a moment anyway (Rosson, 2026-10-17). */
export const FLY_MS = 480;
/** A critically damped spring from rest: no jolt leaving the composer,
 *  no overshoot on landing. Baked into keyframes (linear between). */
export const FLY_EASING = "spring";
/** The blue is fully in a quarter of the way through… */
export const FLY_BLUE_AT = 0.25;
/** …starting from a faint tint, never from nothing. */
export const FLY_BLUE_FROM = 0.15;
/** The text keeps the composer look for only a few frames. */
export const FLY_TEXT_AT = 0.15;
/** The end correction when the real bubble moved mid-flight. */
export const FLY_CORRECT_MS = 180;
/** A delivered-mid-flight bubble brightens after the reveal. */
export const FLY_BRIGHTEN_MS = 240;
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
  collapse: true,
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

/** Fly a clone of `bubble` from `source` into place inside `root` (the
 *  pane: positioned, so the clone shares its CSS variables and stacks above
 *  the composer dock and its footer blur). `glide` moves the list on the
 *  same curve, started after the bubble's resting rect is measured.
 *  `target` finds the real bubble at the end (default: `bubble`). Reveals
 *  it and calls `done` once, after the motion — or at once when it cannot
 *  run. Returns a cancel (the glide too). */
export function runSendFly(opts: {
  root: HTMLElement;
  bubble: HTMLElement;
  source: FlySource;
  done: () => void;
  target?: () => HTMLElement | null;
  glide?: { content: HTMLElement | null; dy: number };
  motion?: FlyMotion;
}): () => void {
  const { root, bubble, source, done } = opts;
  const motion = opts.motion ?? flyMotion();
  let finished = false;
  let clone: HTMLElement | null = null;
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
    // Reveal the real bubble in the same step the clone goes (React's own
    // re-render to un-hide it can land a frame later: never a blank frame).
    const el = real();
    if (el) {
      el.style.visibility = "";
      if (landed && to && base) settle(el, root, to, base, endOpacity);
    }
    clone?.remove();
    clone = null;
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
    const bubbleFont = fontPxOf(bubble.querySelector(".chat-markdown") ?? bubble);
    const s = clampScale(source.fontPx / bubbleFont);

    clone = bubble.cloneNode(true) as HTMLElement;
    clone.setAttribute("data-testid", "send-fly-clone");
    clone.removeAttribute("data-fly-target");
    clone.setAttribute("aria-hidden", "true");
    // The bubble's own content, in its own line breaks.
    const body = document.createElement("div");
    body.setAttribute("data-fly-part", "body");
    while (clone.firstChild) body.appendChild(clone.firstChild);
    clone.appendChild(body);
    // The blue, as its own layer (opacity only), under the text.
    const backdrop = document.createElement("div");
    backdrop.setAttribute("data-fly-part", "backdrop");
    Object.assign(backdrop.style, {
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      borderRadius: "inherit",
      background: blue,
      zIndex: "-1",
      pointerEvents: "none",
      opacity: String(FLY_BLUE_FROM),
    } satisfies Partial<CSSStyleDeclaration>);
    clone.insertBefore(backdrop, body);
    Object.assign(clone.style, {
      position: "absolute",
      left: `${to.left - base.left}px`,
      top: `${to.top - base.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
      margin: "0",
      maxWidth: "none",
      boxSizing: "border-box",
      visibility: "visible",
      pointerEvents: "none",
      // Above the composer dock (z 2) and its footer blur the whole way;
      // under the floating header (z 10) and side panes, exactly where the
      // real bubble paints: no pop at the hand-off.
      zIndex: String(FLY_Z),
      transformOrigin: "0 0",
      willChange: "transform, opacity",
      background: "transparent",
      overflow: "visible",
      transition: "none",
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
    root.appendChild(clone);
    // The list starts moving in the same frame as the clone, on its curve.
    stopGlide = opts.glide ? glideList(opts.glide.content, opts.glide.dy, motion) : () => {};

    const timing = { duration: motion.ms, fill: "both" as const };
    const blueAt = Math.min(Math.max(motion.blueAt, 0.05), 1);
    const textAt = Math.min(FLY_TEXT_AT, blueAt);
    const fly = clone.animate(flyKeyframes(source.rect, to, s, motion, pad), {
      ...timing,
      easing: curveEasing(motion),
    });
    // Blue from a faint tint, mostly in early (ease-out), then held.
    backdrop.animate(
      [
        { opacity: FLY_BLUE_FROM, offset: 0, easing: "ease-out" },
        { opacity: 1, offset: blueAt },
        { opacity: 1, offset: 1 },
      ],
      { ...timing, easing: "linear" }
    );
    // Composer-bright text → the bubble's "Sending…" dim, with the blue.
    clone.animate(
      [
        { opacity: 1, offset: 0, easing: "ease-out" },
        { opacity: endOpacity, offset: blueAt },
        { opacity: endOpacity, offset: 1 },
      ],
      { ...timing, easing: "linear" }
    );
    if (ghost) {
      ghost.animate(
        [
          { opacity: 1, offset: 0, easing: "ease-in" },
          { opacity: 0, offset: textAt },
          { opacity: 0, offset: 1 },
        ],
        { ...timing, easing: "linear" }
      );
      body.animate(
        [
          { opacity: 0, offset: 0, easing: "ease-out" },
          { opacity: 1, offset: textAt },
          { opacity: 1, offset: 1 },
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
      easing: "ease-out",
    });
  }
}
