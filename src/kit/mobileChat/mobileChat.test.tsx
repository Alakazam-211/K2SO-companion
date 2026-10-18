// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { isDismissTap, useTapToDismiss } from "./useTapToDismiss";
import { useKeyboardForwardPlay } from "./useKeyboardForwardPlay";
import { keyboardColumnHeight } from "./useKeyboardFlip";
import type { ViewportMotion } from "../../lib/useViewportHeight";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tap to dismiss ───────────────────────────────────────────────────

function Chat({ canDismiss, menuOpen = false }: { canDismiss?: () => boolean; menuOpen?: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useTapToDismiss({ area: () => area.current, composer: () => bar.current, canDismiss });
  return (
    <>
      <div ref={area} data-testid="area">
        <p data-testid="text">Plain bubble text</p>
        <a href="#x" data-testid="link">
          <span data-testid="link-inner">a link</span>
        </a>
        <button type="button" data-testid="chip">file.pdf</button>
        <div role="button" data-testid="role-btn">card</div>
        <div data-no-dismiss data-testid="opt-out">
          <span data-testid="opt-out-inner">x</span>
        </div>
      </div>
      <div ref={bar} data-testid="bar">
        <textarea data-testid="field" />
        <button type="button" aria-expanded={menuOpen} data-testid="plus">+</button>
      </div>
    </>
  );
}

function pointer(el: Element, type: string, x = 10, y = 10, opts: { id?: number; t?: number } = {}) {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "pointerId", { value: opts.id ?? 1 });
  Object.defineProperty(e, "clientX", { value: x });
  Object.defineProperty(e, "clientY", { value: y });
  if (opts.t != null) Object.defineProperty(e, "timeStamp", { value: opts.t });
  act(() => {
    el.dispatchEvent(e);
  });
}
function tap(el: Element, opts: { move?: number; ms?: number; cancel?: boolean } = {}) {
  pointer(el, "pointerdown", 10, 10, { t: 1000 });
  if (opts.move) pointer(el, "pointermove", 10, 10 + opts.move, { t: 1010 });
  if (opts.cancel) pointer(el, "pointercancel", 10, 10, { t: 1020 });
  pointer(el, "pointerup", 10, 10 + (opts.move ?? 0), { t: 1000 + (opts.ms ?? 80) });
}
function focusField() {
  const f = screen.getByTestId("field") as HTMLTextAreaElement;
  act(() => f.focus());
  expect(document.activeElement).toBe(f);
  return f;
}

describe("useTapToDismiss", () => {
  it("a tap on plain content (or empty space) blurs the composer", () => {
    render(<Chat />);
    focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).not.toBe(screen.getByTestId("field"));
    focusField();
    tap(screen.getByTestId("area"));
    expect(document.activeElement).not.toBe(screen.getByTestId("field"));
  });

  it("taps on links, buttons, role=button, [data-no-dismiss] do not", () => {
    render(<Chat />);
    const f = focusField();
    for (const id of ["link-inner", "chip", "role-btn", "opt-out-inner"]) {
      tap(screen.getByTestId(id));
      expect(document.activeElement).toBe(f);
    }
  });

  it("a drag / scroll (moved or pointer cancelled) and a long press do not", () => {
    render(<Chat />);
    const f = focusField();
    tap(screen.getByTestId("text"), { move: 30 });
    expect(document.activeElement).toBe(f);
    tap(screen.getByTestId("text"), { cancel: true });
    expect(document.activeElement).toBe(f);
    tap(screen.getByTestId("text"), { ms: 700 });
    expect(document.activeElement).toBe(f);
  });

  it("with a text selection it does not", () => {
    render(<Chat />);
    const f = focusField();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as Selection);
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("with the composer's menu open the tap only closes the menu (no blur here)", () => {
    render(<Chat menuOpen />);
    const f = focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("the screen can veto (a terminal in direct typing)", () => {
    render(<Chat canDismiss={() => false} />);
    const f = focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("isDismissTap: the pure rules", () => {
    const p = document.createElement("p");
    const base = { moved: 0, ms: 100, cancelled: false, target: p, selection: "", menuOpen: false };
    expect(isDismissTap(base)).toBe(true);
    expect(isDismissTap({ ...base, moved: 11 })).toBe(false);
    expect(isDismissTap({ ...base, ms: 400 })).toBe(false);
    expect(isDismissTap({ ...base, target: null })).toBe(false);
    expect(isDismissTap({ ...base, selection: "  " })).toBe(true);
  });
});

// ── Forward play (terminal) ──────────────────────────────────────────

const motion = (from: number, to: number): ViewportMotion => ({
  ms: 250,
  easing: "ease-out",
  elapsed: 0,
  from,
  to,
});

function Term({ m, begin, end }: { m: ViewportMotion | null; begin: () => void; end: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useKeyboardForwardPlay({ motion: m, movers: () => [bar.current], hold: { begin, end } });
  return <div ref={bar} data-testid="mover" />;
}

describe("useKeyboardForwardPlay", () => {
  it("plays the composer by transform; holds once at the start, commits once at the end", () => {
    const begin = vi.fn();
    const end = vi.fn();
    const { rerender } = render(<Term m={null} begin={begin} end={end} />);
    expect(begin).not.toHaveBeenCalled();
    const m = motion(844, 508);
    rerender(<Term m={m} begin={begin} end={end} />);
    const mover = screen.getByTestId("mover");
    expect(mover.style.transform).toBe("translate3d(0, -336px, 0)");
    expect(mover.style.transition).toBe("transform 250ms ease-out");
    expect(begin).toHaveBeenCalledTimes(1);
    // Re-renders mid-motion: no second hold, no commit.
    rerender(<Term m={m} begin={begin} end={end} />);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    // The motion clears: one commit (the single re-fit).
    rerender(<Term m={null} begin={begin} end={end} />);
    expect(end).toHaveBeenCalledTimes(1);
    expect(mover.style.transform).toBe("");
    expect(mover.style.transition).toBe("none");
    rerender(<Term m={null} begin={begin} end={end} />);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("keyboardColumnHeight", () => {
  it("full during a drag, held at `from` while the keyboard rises, else the height", () => {
    expect(keyboardColumnHeight({ height: 508, motion: null, interactive: true }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 508, motion: motion(844, 508), interactive: false }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 844, motion: motion(508, 844), interactive: false }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 508, motion: null, interactive: false }, 844)).toBe(508);
  });
});
