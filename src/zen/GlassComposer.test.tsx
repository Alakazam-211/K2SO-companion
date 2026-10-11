// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  COMPOSER_DRAWER_INSET_PX,
  COMPOSER_DRAWER_RADIUS_PX,
  COMPOSER_DRAWER_TUCK_PX,
  COMPOSER_RADIUS_PX,
  GlassComposer,
} from "./GlassComposer";

afterEach(cleanup);

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
      expect(seen).toEqual(["auto|70px"]);
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
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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
    } finally {
      globalThis.ResizeObserver = RO;
      if (ownOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", ownOffset);
    }
  });
});
