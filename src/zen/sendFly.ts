// iMessage-style send: the text lifts out of the composer and flies into
// its outgoing bubble (FLIP). The real bubble is laid out at its final
// spot but hidden; a clone of it starts over the composer text and
// animates back to identity, then the real bubble is revealed. Only
// transform, opacity, background-color and border-radius move (cheap on
// iOS WebKit); nothing is measured while it runs.

export type FlyRect = { left: number; top: number; width: number; height: number };

/** The composer text at Send: where it sat and how big it was drawn. */
export type FlySource = { rect: FlyRect; fontPx: number };

export const FLY_MS = 340;
/** A little overshoot: the bubble settles like a spring. */
export const FLY_EASING = "cubic-bezier(0.34, 1.32, 0.64, 1)";
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

/** Fly a clone of `bubble` from `source` into place inside `root` (the
 *  pane: positioned, so the clone shares its CSS variables and is not
 *  thrown off by a transformed ancestor). Calls `done` once, after the
 *  motion — or at once when it cannot run. Returns a cancel. */
export function runSendFly(opts: {
  root: HTMLElement;
  bubble: HTMLElement;
  source: FlySource;
  done: () => void;
}): () => void {
  const { root, bubble, source, done } = opts;
  let finished = false;
  let clone: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
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
