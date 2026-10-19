// @vitest-environment jsdom
// The send flight's motion (iMessage, frame-matched): one tunable curve
// shared by the bubble and the list glide; the DEV-only override; no jolt
// leaving the composer and a ~2px settle landing; the blue starts as the
// whole composer field pill and shrinks toward the right edge.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FLY_MOTION,
  FLY_BLUE_AT,
  FLY_BLUE_FROM,
  FLY_EASING,
  FLY_MS,
  FLY_TEXT_AT,
  FLY_TEXT_BLUR_PX,
  FLY_START,
  fieldPillOf,
  flyStartShape,
  textWidthOf,
  type FlySource,
  flySourceOfField,
  shapeFlight,
  SEND_FLY_DEBUG_KEY,
  alongCurve,
  curveEasing,
  flyMotion,
  glideList,
  springDamping,
  springProgress,
} from "./sendFly";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the curve", () => {
  it("defaults: iMessage's ~0.42s, a soft spring, faint blue solid by a quarter, instant clear", () => {
    expect(flyMotion()).toEqual({
      ms: FLY_MS,
      easing: FLY_EASING,
      blueAt: FLY_BLUE_AT,
      blueFrom: FLY_BLUE_FROM,
      textAt: FLY_TEXT_AT,
      blurPx: FLY_TEXT_BLUR_PX,
      collapse: false,
      start: "text",
    });
    expect(FLY_START).toBe("text");
    expect(FLY_MS).toBe(420);
    expect(FLY_EASING).toBe("spring(0.85)");
    expect(FLY_BLUE_FROM).toBeCloseTo(0.25);
    expect(FLY_BLUE_AT).toBeCloseTo(0.25);
    expect(FLY_TEXT_AT).toBeCloseTo(0.3);
    expect(FLY_TEXT_BLUR_PX).toBeGreaterThanOrEqual(1);
    expect(FLY_TEXT_BLUR_PX).toBeLessThanOrEqual(2);
  });

  it("the default spring lands with a ~2px settle on a 300px flight, then rests exactly", () => {
    const zeta = springDamping(FLY_EASING)!;
    expect(zeta).toBeCloseTo(0.85);
    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i <= 1000; i++) {
      const p = springProgress(i / 1000, zeta);
      if (p > peak) {
        peak = p;
        peakAt = i / 1000;
      }
    }
    const overshootPx = (peak - 1) * 300;
    expect(overshootPx).toBeGreaterThan(1);
    expect(overshootPx).toBeLessThan(3);
    // The settle is in the back half, and it ends exactly in place.
    expect(peakAt).toBeGreaterThan(0.5);
    expect(springProgress(1, zeta)).toBe(1);
    // Still a gentle first frame leaving the composer.
    expect(springProgress(16.7 / FLY_MS, zeta)).toBeLessThan(0.08);
  });

  it("a spring from rest: exact ends, monotonic (no overshoot), a gentle first frame", () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const p = springProgress(i / 100);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    // First 60fps frame of a 480ms flight: a few percent, not a jump
    // (the old overshoot bezier moved ~15% there).
    expect(springProgress(16.7 / FLY_MS)).toBeLessThan(0.06);
    // Mostly there by the middle, the rest is a calm settle.
    expect(springProgress(0.5)).toBeGreaterThan(0.85);
  });

  it("spring is baked into ~one keyframe per frame (linear between); a CSS easing is two ends", () => {
    const frames = alongCurve(DEFAULT_FLY_MOTION, (p) => ({ opacity: p }));
    expect(frames.length).toBeGreaterThanOrEqual(25);
    expect(frames[0]).toEqual({ opacity: 0, offset: 0 });
    expect(frames[frames.length - 1]).toEqual({ opacity: 1, offset: 1 });
    expect(curveEasing(DEFAULT_FLY_MOTION)).toBe("linear");
    const bez = { ...DEFAULT_FLY_MOTION, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    expect(alongCurve(bez, (p) => ({ opacity: p }))).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(curveEasing(bez)).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(springDamping("spring(0.8)")).toBe(0.8);
    expect(springDamping("ease-out")).toBeNull();
  });

  it("the list glide rides the same curve and holds will-change only while it runs", () => {
    const content = document.createElement("div");
    const anim = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
    const animate = vi.fn(() => anim);
    content.animate = animate as never;
    glideList(content, 60, DEFAULT_FLY_MOTION);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0].transform).toBe("translate3d(0px, 60px, 0px)");
    expect(timing).toEqual({ duration: FLY_MS, easing: "linear" });
    expect(content.style.willChange).toBe("transform");
    anim.onfinish?.();
    expect(content.style.willChange).toBe("");
    // Less than a pixel: nothing to glide.
    animate.mockClear();
    glideList(content, 0.4, DEFAULT_FLY_MOTION);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("DEV tuning override (k2.debug.sendFly)", () => {
  it("applies in a DEV build, read on every send", () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem(
      SEND_FLY_DEBUG_KEY,
      JSON.stringify({
        ms: 600,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        blueAt: 0.3,
        blueFrom: 0.1,
        textAt: 0.4,
        blurPx: 2,
        collapse: true,
        start: "field",
      })
    );
    expect(flyMotion()).toEqual({
      ms: 600,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      blueAt: 0.3,
      blueFrom: 0.1,
      textAt: 0.4,
      blurPx: 2,
      collapse: true,
      start: "field",
    });
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ ms: 420 }));
    expect(flyMotion()).toEqual({ ...DEFAULT_FLY_MOTION, ms: 420 });
  });

  it("is ignored in a production build", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ ms: 900, easing: "linear", blueAt: 0.9 }));
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
  });

  it("bad JSON, out-of-range values or a throwing storage fall back to the defaults", () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, "{nope");
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
    localStorage.setItem(
      SEND_FLY_DEBUG_KEY,
      JSON.stringify({ ms: 5, blueAt: 3, easing: 7, blueFrom: -1, textAt: 9, blurPx: 40, start: "pill" })
    );
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
  });
});

describe("the blue shape: the field pill on frame 1, the bubble at the end", () => {
  const field = { left: 12, top: 700, width: 366, height: 44 };
  const bubble = { left: 230, top: 520, width: 150, height: 60 };

  it("starts exactly on the field rect and ends exactly on the bubble rect", () => {
    const f = shapeFlight(field, bubble, { from: 20, to: 18 });
    expect(f.visibleAt(0)).toEqual(field);
    expect(f.visibleAt(1)).toEqual(bubble);
    // The box is the larger of the two, anchored at the bubble's bottom-right.
    expect(f.box).toEqual({ left: 380 - 366, top: 580 - 60, width: 366, height: 60 });
    // Frame 1 in pixels: the translate moves the anchor to the field's
    // bottom-right corner, the clip leaves exactly the field's size.
    expect(f.move[0].transform).toBe("translate3d(-2px, 164px, 0px)");
    expect(f.clip[0].clipPath).toBe("inset(16px 0px 0px 0px round 20px)");
    const last = f.clip[f.clip.length - 1];
    expect(last.clipPath).toBe("inset(0px 0px 0px 216px round 18px)");
    expect(f.move[f.move.length - 1].transform).toBe("translate3d(0px, 0px, 0px)");
  });

  it("shrinks toward the right edge: the right edge barely moves while the left races in", () => {
    const f = shapeFlight(field, bubble, { from: 20, to: 18 });
    const q = f.visibleAt(0.25);
    const leftMoved = q.left - field.left;
    const rightMoved = q.left + q.width - (field.left + field.width);
    expect(leftMoved).toBeGreaterThan(Math.abs(rightMoved) * 10);
  });

  it("one keyframe a frame on the shared curve, transform and clip-path only", () => {
    const f = shapeFlight(field, bubble, { from: 20, to: 18 });
    expect(f.move.length).toBe(f.clip.length);
    expect(f.move.length).toBeGreaterThanOrEqual(25);
    for (const k of [...f.move, ...f.clip]) {
      for (const prop of Object.keys(k)) expect(["transform", "clipPath", "offset"]).toContain(prop);
    }
  });
});

describe("the fly source", () => {
  it("reads the whole composer field pill (its rect and radius), not just the text box", () => {
    const pill = document.createElement("div");
    pill.setAttribute("data-composer-field", "");
    pill.style.borderRadius = "20px";
    const ta = document.createElement("textarea");
    ta.value = "hello there";
    ta.style.padding = "8px";
    pill.appendChild(ta);
    document.body.appendChild(pill);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const r = this === pill ? { left: 12, top: 700, width: 366, height: 44 } : { left: 50, top: 704, width: 280, height: 36 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
    expect(fieldPillOf(ta)).toEqual({ rect: { left: 12, top: 700, width: 366, height: 44 }, radius: 20 });
    const src = flySourceOfField(ta)!;
    expect(src.field?.rect).toEqual({ left: 12, top: 700, width: 366, height: 44 });
    // The text box is inside its padding (where the ghost text starts).
    expect(src.rect).toEqual({ left: 58, top: 712, width: 264, height: 20 });
    pill.remove();
  });

  it("no pill around the field: no field rect (the flight starts on the text box)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    expect(fieldPillOf(ta)).toBeNull();
    ta.remove();
  });
});

describe("the blue's first frame: the typed text's extent (default) or the field", () => {
  // A nearly edge-to-edge field (ours), its text box inside the + button.
  const field = { rect: { left: 12, top: 700, width: 366, height: 44 }, radius: 22 };
  const textBox = { left: 50, top: 711, width: 290, height: 22 };
  const src = (textWidth: number | null, height = 44): FlySource => ({
    rect: { ...textBox, height: height - 22 },
    fontPx: 17,
    field: { ...field, rect: { ...field.rect, top: 744 - height, height } },
    textWidth,
  });
  // Monospace-ish measure: 8px a character.
  const measure = (line: string) => line.length * 8;

  it("a short message: narrow, from the text's left edge less the bubble padding", () => {
    const tw = textWidthOf("Ok gotcha", "17px sans-serif", 0, textBox.width, measure)!;
    expect(tw).toBe(72);
    const start = flyStartShape(src(tw), "text", 12, 0, 18);
    expect(start.rect).toEqual({ left: 38, top: 700, width: 96, height: 44 });
    expect(start.radius).toBe(22);
    expect(start.rect.width).toBeLessThan(field.rect.width / 3);
  });

  it("a long multi-line message (wraps): the whole text block, the field's full height", () => {
    const text = "This is a much longer message that wraps\nacross several lines in the composer field";
    const tw = textWidthOf(text, "17px sans-serif", 0, textBox.width, measure)!;
    expect(tw).toBe(textBox.width);
    const start = flyStartShape(src(tw, 132), "text", 12, 0, 18);
    // From the text's left edge (less the bubble padding) to the field's
    // right edge: the field less the + beside the text.
    expect(start.rect).toEqual({ left: 38, top: 612, width: 314, height: 132 });
    // A field whose text box spans it: exactly the field's width.
    const wide = { ...src(342, 132), rect: { left: 24, top: 623, width: 342, height: 110 } };
    expect(flyStartShape(wide, "text", 12, 0, 18).rect).toEqual({ left: 12, top: 612, width: 366, height: 132 });
  });

  it("the widest hard line counts, plus letter spacing; at least the bubble's min width (a pill, not a sliver)", () => {
    expect(textWidthOf("ab\nabcd\nabc\n\n", "f", 0.5, 290, measure)).toBe(34);
    const tiny = flyStartShape(src(8), "text", 12, 0, 18);
    expect(tiny.rect.width).toBe(44);
    expect(flyStartShape(src(8), "text", 12, 60, 18).rect.width).toBe(60);
    expect(textWidthOf("x", "f", 0, 290, () => NaN)).toBeNull();
  });

  it("the DEV override \"field\" restores the field-pill start; unmeasured text falls back to it", () => {
    expect(flyStartShape(src(72), "field", 12, 0, 18)).toEqual(field);
    expect(flyStartShape(src(null), "text", 12, 0, 18)).toEqual(field);
    // No field pill: the text box itself.
    const bare = { rect: textBox, fontPx: 17, textWidth: 72 };
    expect(flyStartShape(bare, "text", 12, 0, 18)).toEqual({ rect: textBox, radius: 18 });
    vi.stubEnv("DEV", true);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ start: "field" }));
    expect(flyMotion().start).toBe("field");
    vi.stubEnv("DEV", false);
    expect(flyMotion().start).toBe("text");
  });

  it("the flight from the text's extent still lands exactly on the bubble", () => {
    const start = flyStartShape(src(72), "text", 12, 0, 18);
    const bubble = { left: 280, top: 600, width: 98, height: 38 };
    const f = shapeFlight(start.rect, bubble, { from: start.radius, to: 18 });
    expect(f.visibleAt(0)).toEqual(start.rect);
    expect(f.visibleAt(1)).toEqual(bubble);
  });
});
