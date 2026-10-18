// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { PIN_HOLD_MS, PIN_MENU_MS } from "./pinChats";
import { usePinDrag } from "./usePinDrag";

// K2 0.46.1 Mute: with `listMenu` on, a list row's hold opens its menu —
// a lifted row let go where it was picked up, or a still hold on a row
// that cannot lift (a sidecar). Off: today's gestures exactly.

function Harness({ listMenu, canPin }: { listMenu: boolean; canPin: boolean }) {
  const pins = useRef<HTMLDivElement>(null);
  const d = usePinDrag(pins, () => canPin, () => listMenu);
  return (
    <div
      onPointerDown={d.onPointerDown}
      onPointerMove={d.onPointerMove}
      onPointerUp={d.onPointerUp}
    >
      <div ref={pins} />
      <button type="button" data-pin-id="row1" data-pin-from="list" data-testid="row">
        row
      </button>
      <span data-testid="menu">{d.menu ? `${d.menu.id}:${d.menu.from}` : "none"}</span>
    </div>
  );
}

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = { clientX: 100, clientY: 200, button: 0, pointerId: 1 };

describe("row hold menu", () => {
  it("a lifted row let go in place opens its menu", () => {
    render(<Harness listMenu canPin />);
    fireEvent.pointerDown(screen.getByTestId("row"), at);
    act(() => void vi.advanceTimersByTime(PIN_HOLD_MS + 10));
    fireEvent.pointerUp(screen.getByTestId("row"), at);
    expect(screen.getByTestId("menu").textContent).toBe("row1:list");
  });

  it("a row that cannot lift opens its menu on a still hold", () => {
    render(<Harness listMenu canPin={false} />);
    fireEvent.pointerDown(screen.getByTestId("row"), at);
    act(() => void vi.advanceTimersByTime(PIN_MENU_MS + 10));
    expect(screen.getByTestId("menu").textContent).toBe("row1:list");
  });

  it("off (a server without read state): no row menu", () => {
    render(<Harness listMenu={false} canPin />);
    fireEvent.pointerDown(screen.getByTestId("row"), at);
    act(() => void vi.advanceTimersByTime(PIN_MENU_MS + 10));
    fireEvent.pointerUp(screen.getByTestId("row"), at);
    expect(screen.getByTestId("menu").textContent).toBe("none");
  });
});
