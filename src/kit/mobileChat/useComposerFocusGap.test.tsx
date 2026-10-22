// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";

const kb = vi.hoisted(() => ({ top: null as number | null, held: false }));
vi.mock("../../lib/useViewportHeight", () => ({
  keyboardTopNow: () => kb.top,
  keyboardHeldNow: () => kb.held,
  keyboardMotionMs: () => 250,
}));

import {
  COMPOSER_FOCUSED_ATTR,
  FRESH_FOCUS_MS,
  RETURN_BLUR_MS,
  useComposerFocusGap,
} from "./useComposerFocusGap";

function Screen() {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useComposerFocusGap({ root: () => root.current, bar: () => bar.current });
  return (
    <div ref={root} data-testid="root">
      <div ref={bar}>
        <textarea data-testid="field" />
      </div>
    </div>
  );
}

function will(detail: { show: boolean; active?: boolean }) {
  act(() => {
    window.dispatchEvent(new CustomEvent("k2-keyboard-will", { detail }));
  });
}

/** Focus the composer and raise the keyboard, long enough ago that a hide
 *  is not "fresh". */
function typing() {
  const f = screen.getByTestId("field") as HTMLTextAreaElement;
  act(() => f.focus());
  kb.top = 500;
  will({ show: true, active: true });
  act(() => {
    vi.advanceTimersByTime(FRESH_FOCUS_MS + 50);
  });
  return f;
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  kb.top = null;
  kb.held = false;
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useComposerFocusGap: blur on the keyboard's own hide", () => {
  it("a hide in the foreground blurs the composer and drops the typing gap", () => {
    render(<Screen />);
    const f = typing();
    expect(screen.getByTestId("root").hasAttribute(COMPOSER_FOCUSED_ATTR)).toBe(true);
    kb.top = null;
    will({ show: false, active: true });
    expect(document.activeElement).not.toBe(f);
    expect(screen.getByTestId("root").hasAttribute(COMPOSER_FOCUSED_ATTR)).toBe(false);
  });

  it("a hide from older native code (no `active`) still blurs", () => {
    render(<Screen />);
    const f = typing();
    kb.top = null;
    will({ show: false });
    expect(document.activeElement).not.toBe(f);
  });

  it("a hide while the app leaves the screen does not blur until the app is back", () => {
    render(<Screen />);
    const f = typing();
    kb.top = null;
    visibility = "hidden";
    will({ show: false, active: false });
    expect(document.activeElement).toBe(f);
    // The typing gap stays while away (the app comes back as it was left).
    expect(screen.getByTestId("root").hasAttribute(COMPOSER_FOCUSED_ATTR)).toBe(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(RETURN_BLUR_MS * 3);
    });
    expect(document.activeElement).toBe(f); // still away
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(RETURN_BLUR_MS - 1);
    });
    expect(document.activeElement).toBe(f);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.activeElement).not.toBe(f);
    expect(screen.getByTestId("root").hasAttribute(COMPOSER_FOCUSED_ATTR)).toBe(false);
  });

  it("the keyboard's height still held at the return deadline: no keyboard came back, blur", () => {
    render(<Screen />);
    const f = typing();
    will({ show: false, active: false });
    kb.held = true; // useViewportHeight keeps the keyboard's top while away
    act(() => {
      window.dispatchEvent(new Event("k2-viewport-resync"));
      vi.advanceTimersByTime(RETURN_BLUR_MS);
    });
    expect(document.activeElement).not.toBe(f);
  });

  it("back in the foreground with the keyboard restored by iOS: no blur, typing gap back", () => {
    render(<Screen />);
    const f = typing();
    kb.top = null;
    will({ show: false, active: false });
    act(() => {
      window.dispatchEvent(new Event("k2-viewport-resync"));
    });
    kb.top = 500;
    will({ show: true, active: true });
    act(() => {
      vi.advanceTimersByTime(RETURN_BLUR_MS * 2);
    });
    expect(document.activeElement).toBe(f);
    expect(screen.getByTestId("root").hasAttribute(COMPOSER_FOCUSED_ATTR)).toBe(true);
  });
});
