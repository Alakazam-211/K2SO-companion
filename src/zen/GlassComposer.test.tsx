// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import {
  COMPOSER_DRAWER_INSET_PX,
  COMPOSER_DRAWER_RADIUS_PX,
  COMPOSER_DRAWER_TUCK_PX,
  COMPOSER_RADIUS_PX,
  GlassComposer,
  SETTLED_HEIGHT_ATTR,
  composerBlockHeight,
  settledHeight,
} from "./GlassComposer";
import { FLY_MS, SEND_FLY_DEBUG_KEY } from "./sendFly";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderComposer = (drawer?: React.ReactNode) =>
  render(
    <GlassComposer
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      canSend
      sendReady={false}
      drawer={drawer}
    >
      <p data-testid="row">label</p>
    </GlassComposer>
  );

describe("GlassComposer drawer slot", () => {
  it("renders the drawer inside its own wrapper, directly before the field", () => {
    renderComposer(<div data-testid="my-drawer" />);
    const slot = screen.getByTestId("composer-drawer");
    const field = screen.getByTestId("composer-field");
    expect(slot.contains(screen.getByTestId("my-drawer"))).toBe(true);
    expect(slot.nextElementSibling).toBe(field);
    expect(slot.parentElement).toBe(field.parentElement);
    expect(slot.parentElement).toBe(screen.getByTestId("composer-dock"));
    expect(screen.getByTestId("composer-bar").style.overflow).toBe("visible");
  });

  it("insets the drawer by half the field's radius and tucks it under the field's top edge", () => {
    renderComposer(<div />);
    const slot = screen.getByTestId("composer-drawer");
    const field = screen.getByTestId("composer-field");
    expect(field.style.borderRadius).toBe(`${COMPOSER_RADIUS_PX}px`);
    expect(COMPOSER_DRAWER_INSET_PX).toBe(COMPOSER_RADIUS_PX * 0.5);
    expect(slot.style.left).toBe(`${COMPOSER_RADIUS_PX * 0.5}px`);
    expect(slot.style.right).toBe(`${COMPOSER_RADIUS_PX * 0.5}px`);
    // Flush: the clip edge sits under the field's top, no gap.
    expect(slot.style.bottom).toBe(`calc(100% - ${COMPOSER_DRAWER_TUCK_PX}px)`);
    expect(slot.style.paddingBottom).toBe("");
    expect(slot.className).not.toMatch(/(^|\s)(mb|pb)-/);
    // Deep enough to reach under the corner curve at the inset.
    const r = COMPOSER_RADIUS_PX;
    const drop = r - Math.sqrt(r * r - (r - COMPOSER_DRAWER_INSET_PX) ** 2);
    expect(COMPOSER_DRAWER_TUCK_PX).toBeGreaterThan(drop);
    // Behind the field.
    expect(Number(slot.style.zIndex)).toBeLessThan(Number(field.style.zIndex));
    expect(slot.style.getPropertyValue("--k2-drawer-radius")).toBe(`${COMPOSER_DRAWER_RADIUS_PX}px`);
    expect(slot.style.getPropertyValue("--k2-drawer-tuck")).toBe(`${COMPOSER_DRAWER_TUCK_PX}px`);
  });

  it("without a drawer: no slot and the bar clips as before", () => {
    renderComposer();
    expect(screen.queryByTestId("composer-drawer")).toBeNull();
    expect(screen.getByTestId("composer-bar").style.overflow).toBe("");
  });
});

describe("GlassComposer field auto-grow", () => {
  it("holds the bar at its height while measuring the field, so the column above never grows (and clamps its scroll)", () => {
    const seen: string[] = [];
    const ownOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const ownScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "composer-bar" ? 70 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.tagName !== "TEXTAREA") return 0;
        const bar = this.closest('[data-testid="composer-bar"]') as HTMLElement | null;
        seen.push(`${this.style.height}|${bar?.style.minHeight ?? ""}`);
        return 88;
      },
    });
    try {
      render(
        <GlassComposer value={"a\nb\nc\nd"} onChange={() => {}} onSubmit={() => {}} canSend sendReady />
      );
      // The measuring read happens with the bar held; later reads (keeping
      // the caret in view) come after the field is sized.
      expect(seen[0]).toBe("auto|70px");
      expect(screen.getByTestId("composer-input").style.height).toBe("88px");
      expect(screen.getByTestId("composer-bar").style.minHeight).toBe("");
    } finally {
      if (ownOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", ownOffset);
      if (ownScroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", ownScroll);
    }
  });

  it("reports the whole block's height on mount and on each resize", () => {
    let px = 60;
    let fire: () => void = () => {};
    const ownOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "composer-bar" ? px : 0;
      },
    });
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(_el: Element, opts?: { box?: string }) {
        boxes.push(opts?.box);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const boxes: (string | undefined)[] = [];
    const heights: number[] = [];
    try {
      render(
        <GlassComposer
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          canSend
          sendReady={false}
          onBlockHeight={(h) => heights.push(h)}
        />
      );
      px = 104;
      fire();
      fire();
      expect(heights).toEqual([60, 104]);
      // Padding (the home-indicator inset) counts: the border box.
      expect(boxes).toEqual(["border-box"]);
      // The keyboard closing (focus leaves) re-reads on the next frame.
      px = 130;
      const raf = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      }) as typeof requestAnimationFrame;
      try {
        fireEvent.focusOut(screen.getByTestId("composer-bar").querySelector("textarea")!);
      } finally {
        globalThis.requestAnimationFrame = raf;
      }
      expect(heights).toEqual([60, 104, 130]);
    } finally {
      globalThis.ResizeObserver = RO;
      if (ownOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", ownOffset);
    }
  });
});

describe("composerBlockHeight", () => {
  it("leaves out the bar's bottom gap (the Thread's spacer eases with it)", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    try {
      bar.getBoundingClientRect = () => ({ height: 100.4 }) as DOMRect;
      Object.defineProperty(bar, "offsetHeight", { configurable: true, value: 100 });
      // No bottom padding: the whole block.
      expect(composerBlockHeight(bar)).toBe(100);
      // Mid-ease (34px → 8px) the block and the gap move together: the
      // reported height does not change frame to frame.
      bar.style.paddingBottom = "34px";
      expect(composerBlockHeight(bar)).toBe(66);
      bar.style.paddingBottom = "20.4px";
      bar.getBoundingClientRect = () => ({ height: 86.8 }) as DOMRect;
      expect(composerBlockHeight(bar)).toBe(66);
    } finally {
      bar.remove();
    }
  });
});

describe("GlassComposer attach (+)", () => {
  it("does not take focus from the textarea (keyboard stays up), and opens our menu, not a picker", () => {
    renderComposer();
    const attach = screen.getByTestId("composer-attach");
    for (const type of ["pointerDown", "mouseDown"] as const) {
      const ev = createEvent[type](attach);
      fireEvent(attach, ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    let opened = 0;
    for (const input of Array.from(document.querySelectorAll('input[type="file"]'))) {
      (input as HTMLInputElement).click = () => {
        opened += 1;
      };
    }
    fireEvent.click(attach);
    expect(opened).toBe(0);
    expect(screen.getByRole("menu", { name: "Attach" })).not.toBeNull();
  });
});

describe("a send's clear: instant by default (iMessage), eased only with the DEV collapse override", () => {
  function Harness({ value, smooth }: { value: string; smooth: boolean }) {
    return (
      <GlassComposer value={value} onChange={() => {}} onSubmit={() => {}} canSend sendReady smoothClear={smooth} />
    );
  }
  function stubField(lines: () => number) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === "TEXTAREA" ? 22 * lines() + 8 : 0;
      },
    });
    return () => {
      if (desc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", desc);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    };
  }

  it("default: a multi-line draft snaps to one empty line in the same commit (placeholder back at once)", () => {
    let lines = 3;
    const restore = stubField(() => lines);
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    try {
      const { rerender } = render(<Harness value={"a\nb\nc"} smooth />);
      const field = screen.getByTestId("composer-input") as HTMLTextAreaElement;
      expect(field.style.height).toBe("74px");
      lines = 1;
      rerender(<Harness value="" smooth />);
      // Same commit: empty, one line, nothing easing, no settled marker.
      expect(field.value).toBe("");
      expect(field.style.height).toBe("30px");
      expect(animate).not.toHaveBeenCalled();
      expect(field.hasAttribute(SETTLED_HEIGHT_ATTR)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      localStorage.removeItem(SEND_FLY_DEBUG_KEY);
      restore();
      // @ts-expect-error test cleanup
      delete Element.prototype.animate;
    }
  });

  it("DEV collapse override: the height eases on the flight's curve; settledHeight reads its end", () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ collapse: true }));
    let lines = 3;
    const restore = stubField(() => lines);
    const anim = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
    const animate = vi.fn(() => anim);
    Element.prototype.animate = animate as never;
    try {
      const { rerender } = render(<Harness value={"a\nb\nc"} smooth />);
      const field = screen.getByTestId("composer-input");
      expect(field.style.height).toBe("74px");
      lines = 1;
      rerender(<Harness value="" smooth />);
      expect(field.style.height).toBe("30px");
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
      expect(frames[0].height).toBe("74px");
      expect(frames[frames.length - 1].height).toBe("30px");
      expect(timing.duration).toBe(FLY_MS);
      expect(field.getAttribute(SETTLED_HEIGHT_ATTR)).toBe("30");
      // Mid-collapse the field is still 60px tall: the block reports its end.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const h = this.tagName === "TEXTAREA" ? 60 : this.getAttribute("data-testid") === "composer-bar" ? 100 : 0;
        return { left: 0, top: 0, width: 300, height: h, right: 300, bottom: h, x: 0, y: 0, toJSON: () => ({}) };
      });
      expect(settledHeight(screen.getByTestId("composer-bar"))).toBe(70);
      anim.onfinish?.();
      expect(field.hasAttribute(SETTLED_HEIGHT_ATTR)).toBe(false);
    } finally {
      restore();
      // @ts-expect-error test cleanup
      delete Element.prototype.animate;
    }
  });

  it("without smoothClear (or a one-line draft) it snaps as before", () => {
    let lines = 3;
    const restore = stubField(() => lines);
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    try {
      const { rerender } = render(<Harness value={"a\nb\nc"} smooth={false} />);
      lines = 1;
      rerender(<Harness value="" smooth={false} />);
      expect(animate).not.toHaveBeenCalled();
      rerender(<Harness value="one" smooth />);
      rerender(<Harness value="" smooth />);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      restore();
      // @ts-expect-error test cleanup
      delete Element.prototype.animate;
    }
  });
});

describe("GlassComposer send press", () => {
  it("brightens the send pill while pressed, only when it can send", () => {
    render(
      <GlassComposer value="hi" onChange={() => {}} onSubmit={() => {}} canSend sendReady testIdPrefix="p" />
    );
    const send = screen.getByTestId("p-send");
    expect(send.style.filter).toBe("");
    fireEvent.pointerDown(send);
    expect(send.style.filter).toBe("brightness(1.5)");
    fireEvent.pointerUp(send);
    expect(send.style.filter).toBe("");
  });
});

describe("GlassComposer + lit", () => {
  it("lights the + while pressed and while its menu is open", () => {
    render(
      <GlassComposer value="" onChange={() => {}} onSubmit={() => {}} canSend sendReady={false} onAttach={() => {}} testIdPrefix="q" />
    );
    const plus = screen.getByTestId("q-attach");
    expect(plus.hasAttribute("data-lit")).toBe(false);
    fireEvent.pointerDown(plus);
    expect(plus.hasAttribute("data-lit")).toBe(true);
    fireEvent.pointerUp(plus);
    expect(plus.hasAttribute("data-lit")).toBe(false);
    fireEvent.click(plus);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    expect(plus.hasAttribute("data-lit")).toBe(true);
    expect(plus.style.background).toContain("rgba(255, 255, 255, 0.2)");
  });
});

describe("GlassComposer keeps the caret in view at max height", () => {
  it("a caret at the end scrolls the full-height field to its last line", async () => {
    const { keepCaretInView } = await import("./GlassComposer");
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(ta, "clientHeight", { configurable: true, get: () => 132 });
    ta.value = "a\nb\nc\nd\ne\nf\n\n";
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollTop = 0;
    keepCaretInView(ta, 0);
    expect(ta.scrollTop).toBeGreaterThan(0);
    ta.remove();
  });

  it("an unfocused field keeps its own scroll", async () => {
    const { keepCaretInView } = await import("./GlassComposer");
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(ta, "clientHeight", { configurable: true, get: () => 132 });
    ta.value = "a\nb\nc";
    keepCaretInView(ta, 40);
    expect(ta.scrollTop).toBe(40);
    ta.remove();
  });
});
