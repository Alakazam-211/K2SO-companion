// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { breatheOpacityAt, DELIVER_BRIGHTEN_MS, SENDING_OPACITY, useDeliverBrighten } from "./useDeliverBrighten";

afterEach(cleanup);

const animate = vi.fn();
function Box({ pending, flying = false }: { pending: boolean; flying?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDeliverBrighten(ref, pending, pending && !flying, flying);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) (el as unknown as { animate: typeof animate }).animate = animate;
      }}
    />
  );
}

describe("useDeliverBrighten", () => {
  it("brightens gradually from the sending dim to full on delivery", () => {
    animate.mockClear();
    const { rerender } = render(<Box pending />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Box pending={false} />);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, opts] = animate.mock.calls[0];
    expect(frames[1]).toEqual({ opacity: 1 });
    expect(frames[0].opacity).toBeGreaterThanOrEqual(SENDING_OPACITY);
    expect(frames[0].opacity).toBeLessThanOrEqual(0.8);
    expect(opts.duration).toBe(DELIVER_BRIGHTEN_MS);
  });

  it("leaves it to the flight while the bubble is still flying", () => {
    animate.mockClear();
    const { rerender } = render(<Box pending flying />);
    rerender(<Box pending={false} flying />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("a bubble that was never pending does nothing", () => {
    animate.mockClear();
    const { rerender } = render(<Box pending={false} />);
    rerender(<Box pending={false} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("follows the breathe curve (0.7 ↔ 0.8, 1.2 s, alternate)", () => {
    expect(breatheOpacityAt(0)).toBeCloseTo(0.7);
    expect(breatheOpacityAt(600)).toBeCloseTo(0.75);
    expect(breatheOpacityAt(1200)).toBeCloseTo(0.8);
    expect(breatheOpacityAt(2400)).toBeCloseTo(0.7);
  });
});
