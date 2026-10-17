// iMessage-style send: the text lifts out of the composer and flies into
// its outgoing bubble (FLIP). The real bubble is laid out at its final
// spot but hidden; a clone of it starts over the composer text and
// animates back to identity, then the real bubble is revealed. Only
// transform, opacity, background-color and border-radius animate (cheap
// on iOS WebKit). The clone's box follows the real bubble each frame (one
// rect read), so a list that moves under it mid-flight (the glide, the
// composer or the working drawer changing the bottom padding, the server's
// copy landing) cannot leave it a few px off: at the end the clone sits
// exactly on the bubble and the hand-off moves nothing.

export type FlyRect = { left: number; top: number; width: number; height: number };

/** The composer text at Send: where it sat and how big it was drawn. */
export type FlySource = { rect: FlyRect; fontPx: number };

export const FLY_MS = 340;
/** A little overshoot: the bubble settles like a spring. */
export const FLY_EASING = "cubic-bezier(0.34, 1.32, 0.64, 1)";
/** The list making room: no overshoot (the messages must not bounce). */
export const GLIDE_EASING = "cubic-bezier(0.2, 0.9, 0.3, 1)";
/** Bubble padding (Bubble's `px-3 py-2`). */
const PAD_X = 12;
const PAD_Y = 8;

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

/** Keyframes taking the bubble (laid out at `to`) from the composer text
 *  at `from` back to itself: a uniform scale (composer font / bubble
 *  font, so letters keep their shape) and a translate that puts the
 *  bubble's text origin on the composer's. Glass → blue, 20 → 18 radius. */
export function flyKeyframes(
  from: FlyRect,
  to: FlyRect,
  scale: number
): Keyframe[] {
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, 0.5), 2) : 1;
  const dx = Math.round(from.left - to.left - PAD_X * s);
  const dy = Math.round(from.top - to.top - PAD_Y * s);
  return [
    {
      transform: `translate(${dx}px, ${dy}px) scale(${s.toFixed(3)})`,
      backgroundColor: "rgba(10, 132, 255, 0)",
      borderRadius: "20px",
    },
    {
      transform: "translate(0px, 0px) scale(1)",
      backgroundColor: "rgb(10, 132, 255)",
      borderRadius: "18px",
    },
  ];
}

/** The list makes room for the new row: it was laid out (and stuck to
 *  the newest) with the row in it, which moved the messages above up by
 *  `dy` in one frame. Start them `dy` lower and glide them up while the
 *  bubble flies in. Layout is untouched (a transform), so scrolling and
 *  the bubble's final rect stay true. Returns a cancel. */
export function glideList(content: HTMLElement | null, dy: number): () => void {
  if (!content || !(dy >= 1) || typeof content.animate !== "function") return () => {};
  const anim = content.animate(
    [{ transform: `translateY(${Math.round(dy)}px)` }, { transform: "translateY(0px)" }],
    { duration: FLY_MS, easing: GLIDE_EASING }
  );
  return () => {
    try {
      anim.cancel();
    } catch {
      /* already gone */
    }
  };
}

/** Fly a clone of `bubble` from `source` into place inside `root` (the
 *  pane: positioned, so the clone shares its CSS variables and is not
 *  thrown off by a transformed ancestor). `target` finds the real bubble
 *  each frame (default: `bubble`). Reveals it and calls `done` once,
 *  after the motion — or at once when it cannot run. Returns a cancel. */
export function runSendFly(opts: {
  root: HTMLElement;
  bubble: HTMLElement;
  source: FlySource;
  done: () => void;
  target?: () => HTMLElement | null;
}): () => void {
  const { root, bubble, source, done } = opts;
  let finished = false;
  let clone: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let raf = 0;
  const real = (): HTMLElement | null => {
    const el = opts.target?.() ?? null;
    if (el) return el;
    return bubble.isConnected ? bubble : null;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    // Reveal the real bubble in the same frame the clone goes (React's own
    // re-render to un-hide it can land a frame later: never a blank frame).
    const el = real();
    if (el) el.style.visibility = "";
    clone?.remove();
    clone = null;
    done();
  };
  const to = rectOf(bubble);
  const base = rectOf(root);
  if (!to || !base || typeof bubble.animate !== "function") {
    finish();
    return finish;
  }
  const bubbleFont = fontPxOf(bubble.querySelector(".chat-markdown") ?? bubble);
  const scale = source.fontPx / bubbleFont;
  clone = bubble.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-testid");
  clone.setAttribute("data-testid", "send-fly-clone");
  clone.setAttribute("aria-hidden", "true");
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
    zIndex: "40",
    transformOrigin: "0 0",
    willChange: "transform",
  } satisfies Partial<CSSStyleDeclaration>);
  root.appendChild(clone);
  // Keep the clone's box on the real bubble's (rect read once a frame).
  const flight = clone;
  let at = { ...to, baseLeft: base.left, baseTop: base.top };
  const track = () => {
    raf = 0;
    if (finished) return;
    const el = real();
    const r = rectOf(el);
    const b = rectOf(root);
    if (el && r && b && (r.width > 0 || r.height > 0)) {
      const moved =
        Math.abs(r.left - b.left - (at.left - at.baseLeft)) > 0.5 ||
        Math.abs(r.top - b.top - (at.top - at.baseTop)) > 0.5;
      if (moved) {
        flight.style.left = `${r.left - b.left}px`;
        flight.style.top = `${r.top - b.top}px`;
      }
      if (Math.abs(r.width - at.width) > 0.5) flight.style.width = `${r.width}px`;
      if (Math.abs(r.height - at.height) > 0.5) flight.style.height = `${r.height}px`;
      at = { ...r, baseLeft: b.left, baseTop: b.top };
      // Delivered mid-flight: brighten with it (same transition).
      if (el.style.opacity !== flight.style.opacity) flight.style.opacity = el.style.opacity;
    }
    raf = requestAnimationFrame(track);
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(track);
  const anim = clone.animate(flyKeyframes(source.rect, to, scale), {
    duration: FLY_MS,
    easing: FLY_EASING,
    fill: "both",
  });
  anim.onfinish = finish;
  anim.oncancel = finish;
  // A backgrounded WebView may never fire finish: never leave it hidden.
  timer = setTimeout(finish, FLY_MS + 400);
  return () => {
    try {
      anim.cancel();
    } catch {
      /* already gone */
    }
    finish();
  };
}
