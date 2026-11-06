// @vitest-environment jsdom
// "See more" on long messages (MessageFold): the threshold by rendered
// height against the body's line-height, open / fold, a streaming message
// crossing the threshold without a jump, a search hit opening it, the
// state kept per message, and the bubble's top kept still.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  __resetFoldForTests,
  createFoldHost,
  FOLD_CLIP_LINES,
  FOLD_LINES,
  FoldContext,
  foldClipPx,
  foldable,
  MessageFold,
  readLinePx,
  revealFolded,
  type FoldHost,
} from "./MessageFold";

const LINE = 21;
const CLIP = foldClipPx(LINE); // 273

// ── ResizeObserver: the test reports heights by hand.
type Obs = { cb: (entries?: ResizeObserverEntry[]) => void; targets: Element[] };
let observers: Obs[] = [];
function report(target: Element, height: number) {
  const o = observers.find((x) => x.targets.includes(target));
  if (!o) throw new Error("not observed");
  act(() => o.cb([{ target, contentRect: { height } } as unknown as ResizeObserverEntry]));
}

const realGcs = window.getComputedStyle.bind(window);
let scrollerPadTop = "0px";

beforeEach(() => {
  __resetFoldForTests();
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      o: Obs;
      constructor(cb: Obs["cb"]) {
        this.o = { cb, targets: [] };
        observers.push(this.o);
      }
      observe(t: Element) {
        this.o.targets.push(t);
      }
      unobserve() {}
      disconnect() {
        this.o.targets = [];
      }
    }
  );
  // The body's computed line-height (WebKit resolves `1.5` to px).
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    const cs = realGcs(el);
    const over: Record<string, string> = el.classList?.contains("chat-markdown")
      ? { lineHeight: `${LINE}px`, fontSize: "14px" }
      : el.getAttribute?.("data-testid") === "scroller"
        ? { paddingTop: scrollerPadTop, overflowY: "auto" }
        : {};
    return new Proxy(cs, {
      get(t, k: string) {
        if (k in over) return over[k];
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Body({ text }: { text: string }) {
  return (
    <div className="chat-markdown" data-testid="body">
      {text}
    </div>
  );
}

function host(over: Partial<FoldHost> = {}): FoldHost {
  return {
    ...createFoldHost({ scroller: () => document.querySelector<HTMLElement>("[data-testid=scroller]"), unfollow: vi.fn() }),
    ...over,
  };
}

function renderFold(h: FoldHost, opts: { text?: string; foldKey?: string; reveal?: boolean } = {}) {
  const ui = (o: typeof opts) => (
    <FoldContext.Provider value={h}>
      <div data-testid="scroller">
        <div data-thread-msg="" data-testid="row">
          <MessageFold foldKey={o.foldKey ?? "m1"} fontSize="14px" reveal={o.reveal}>
            <Body text={o.text ?? "long words"} />
          </MessageFold>
        </div>
      </div>
    </FoldContext.Provider>
  );
  const r = render(ui(opts));
  return { ...r, rerenderWith: (o: typeof opts) => r.rerender(ui({ ...opts, ...o })) };
}

const inner = () => screen.getByTestId("fold-inner");
const clip = () => screen.getByTestId("fold-clip");
const toggle = () => screen.queryByTestId("fold-toggle");

describe("the threshold", () => {
  it("folds only past FOLD_LINES + 1 lines by height (the button's row is the one more)", () => {
    expect(FOLD_LINES).toBe(14);
    expect(FOLD_CLIP_LINES).toBe(15);
    expect(foldable(LINE * 14, LINE)).toBe(false);
    expect(foldable(LINE * 15, LINE)).toBe(false);
    expect(foldable(LINE * 15 + 1, LINE)).toBe(true);
    expect(foldable(LINE * 500, LINE)).toBe(true);
    // No line-height yet: never folds.
    expect(foldable(10_000, 0)).toBe(false);
  });

  it("reads the computed line-height: px, unitless × font-size, normal ≈ 1.2em", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    vi.mocked(window.getComputedStyle).mockImplementation(
      () => ({ lineHeight: "22.5px", fontSize: "15px" }) as CSSStyleDeclaration
    );
    expect(readLinePx(el)).toBe(22.5);
    vi.mocked(window.getComputedStyle).mockImplementation(
      () => ({ lineHeight: "1.5", fontSize: "14px" }) as CSSStyleDeclaration
    );
    expect(readLinePx(el)).toBe(21);
    vi.mocked(window.getComputedStyle).mockImplementation(
      () => ({ lineHeight: "normal", fontSize: "10px" }) as CSSStyleDeclaration
    );
    expect(readLinePx(el)).toBe(12);
    el.remove();
  });

  it("the clip is on from the first paint (no layout change when measured); a short message shows no button", () => {
    renderFold(host());
    // Before any measurement: the CSS estimate in the body's em.
    expect(clip().style.maxHeight).toBe(`${FOLD_CLIP_LINES * 1.5}em`);
    report(inner(), LINE * 4);
    expect(clip().style.maxHeight).toBe(`${CLIP}px`);
    expect(toggle()).toBeNull();
    expect(document.querySelector(".zen-fold-fade")).toBeNull();
  });

  it("a long message: the fade and a real See more button, aria-expanded false, controlling the clip", () => {
    renderFold(host());
    report(inner(), LINE * 40);
    const b = toggle()!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("type")).toBe("button");
    expect(b.textContent).toBe("See more");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe(clip().id);
    expect(document.querySelector(".zen-fold-fade")!.getAttribute("aria-hidden")).toBe("true");
    expect(clip().style.maxHeight).toBe(`${CLIP}px`);
  });
});

describe("open and fold", () => {
  it("See more opens in place (all the words, See less); See less folds again", () => {
    const h = host();
    renderFold(h);
    report(inner(), LINE * 40);
    fireEvent.click(toggle()!);
    expect(toggle()!.textContent).toBe("See less");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(clip().style.maxHeight).toBe("");
    expect(document.querySelector(".zen-fold-fade")).toBeNull();
    expect(h.open.has("m1")).toBe(true);
    // Opening near the newest must not stick the list under the reader.
    expect(h.unfollow).toHaveBeenCalled();
    fireEvent.click(toggle()!);
    expect(toggle()!.textContent).toBe("See more");
    expect(clip().style.maxHeight).toBe(`${CLIP}px`);
    expect(h.open.has("m1")).toBe(false);
  });

  it("an open message stays open when its row is drawn again (the render window), per message", () => {
    const h = host();
    const r = renderFold(h);
    report(inner(), LINE * 40);
    fireEvent.click(toggle()!);
    r.unmount();
    renderFold(h);
    // Open from the first paint, before any measurement: no jump.
    expect(clip().style.maxHeight).toBe("");
    expect(toggle()!.textContent).toBe("See less");
    cleanup();
    renderFold(h, { foldKey: "m2" });
    expect(clip().style.maxHeight).not.toBe("");
  });

  it("a streaming message folds once it passes the threshold, the clip never changing height", () => {
    const { rerenderWith } = renderFold(host(), { text: "a" });
    report(inner(), LINE * 3);
    const heights: string[] = [clip().style.maxHeight];
    for (const lines of [6, 10, 13, 14, 20, 60]) {
      rerenderWith({ text: "a ".repeat(lines * 20) });
      report(inner(), LINE * lines);
      heights.push(clip().style.maxHeight);
      expect(toggle() != null).toBe(lines > FOLD_CLIP_LINES);
    }
    // One height throughout: what shows grows to the clip, then stops.
    expect(new Set(heights)).toEqual(new Set([`${CLIP}px`]));
    expect(toggle()!.textContent).toBe("See more");
  });
});

describe("a search hit in the hidden part", () => {
  it("revealFolded on a node inside opens it", () => {
    renderFold(host());
    report(inner(), LINE * 40);
    act(() => revealFolded(screen.getByTestId("body")));
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("a short message ignores it", () => {
    renderFold(host());
    report(inner(), LINE * 4);
    act(() => revealFolded(screen.getByTestId("body")));
    expect(toggle()).toBeNull();
    expect(clip().style.maxHeight).toBe(`${CLIP}px`);
  });

  it("landing on it (reveal) opens it once; See less while still landed stays folded", () => {
    const { rerenderWith } = renderFold(host(), { reveal: false });
    report(inner(), LINE * 40);
    rerenderWith({ reveal: true });
    expect(toggle()!.textContent).toBe("See less");
    fireEvent.click(toggle()!);
    expect(toggle()!.textContent).toBe("See more");
    rerenderWith({ reveal: true });
    expect(toggle()!.textContent).toBe("See more");
  });

  it("landing before it was measured opens it once measured", () => {
    renderFold(host(), { reveal: true });
    expect(toggle()).toBeNull();
    report(inner(), LINE * 40);
    expect(toggle()!.textContent).toBe("See less");
  });
});

describe("the bubble's top stays put", () => {
  // The scroller sits at y=0; the row's top in the content is `offset`.
  let scrollTop = 0;
  let offset = 500;
  function wire() {
    const sc = screen.getByTestId("scroller");
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    sc.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400, height: 600, width: 400 }) as DOMRect;
    screen.getByTestId("row").getBoundingClientRect = () => {
      const top = offset - scrollTop;
      return { top, bottom: top + 100, left: 0, right: 300, height: 100, width: 300 } as DOMRect;
    };
  }
  beforeEach(() => {
    scrollTop = 0;
    offset = 500;
    scrollerPadTop = "0px";
  });

  it("opening: content grows below, nothing above moves, scrollTop untouched", () => {
    const h = host({ ownScroll: vi.fn() });
    renderFold(h);
    wire();
    scrollTop = 200;
    report(inner(), LINE * 40);
    fireEvent.click(toggle()!);
    expect(scrollTop).toBe(200);
    expect(h.ownScroll).not.toHaveBeenCalled();
  });

  it("opening where the layout would carry the top away (a bottom-aligned list): corrected before paint", () => {
    const h = host({ ownScroll: vi.fn() });
    renderFold(h);
    wire();
    scrollTop = 200;
    report(inner(), LINE * 40);
    const row = screen.getByTestId("row");
    const before = row.getBoundingClientRect().top;
    // Once open, the layout puts the row 300px higher in the content.
    row.getBoundingClientRect = () => {
      const open = clip().style.maxHeight === "";
      const top = (open ? offset - 300 : offset) - scrollTop;
      return { top, bottom: top + 100, left: 0, right: 300, height: 100, width: 300 } as DOMRect;
    };
    fireEvent.click(toggle()!);
    expect(row.getBoundingClientRect().top).toBe(before);
    expect(scrollTop).toBe(-100);
    expect(h.ownScroll).toHaveBeenCalled();
  });

  it("folding with the top in view keeps it where it was", () => {
    const h = host({ refollow: vi.fn() });
    renderFold(h);
    wire();
    report(inner(), LINE * 40);
    fireEvent.click(toggle()!);
    scrollTop = 300; // row top at 200: in view
    fireEvent.click(toggle()!);
    expect(scrollTop).toBe(300);
    expect(h.refollow).toHaveBeenCalled();
  });

  it("folding from deep inside a long message brings its top back under the header", () => {
    scrollerPadTop = "60px";
    renderFold(host());
    wire();
    report(inner(), LINE * 400);
    fireEvent.click(toggle()!);
    scrollTop = 4000; // row top far above the view
    fireEvent.click(toggle()!);
    // Top at the view's top (under the 60px header) plus 8px of air.
    expect(screen.getByTestId("row").getBoundingClientRect().top).toBe(68);
  });
});
