// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  captureTopMessage,
  restoreTopMessage,
  stickToNewest,
} from "./threadScroll";

function box(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("threadScroll", () => {
  it("sticks to the newest by setting scrollTop to scrollHeight", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 2400 });
    el.scrollTop = 0;
    stickToNewest(el);
    expect(el.scrollTop).toBe(2400);
  });

  it("captures the first message that crosses the scroller top", () => {
    const scroller = document.createElement("div");
    box(scroller, 100, 400);
    const a = document.createElement("div");
    const b = document.createElement("div");
    box(a, 40, 50);
    box(b, 110, 50);
    expect(captureTopMessage(scroller, [a, b])?.el).toBe(b);
  });

  it("restores by the element's rect delta, not scrollHeight", () => {
    const scroller = document.createElement("div");
    scroller.scrollTop = 200;
    const msg = document.createElement("div");
    document.body.appendChild(msg);
    box(msg, 180, 40);
    restoreTopMessage(scroller, { el: msg, top: 80 });
    expect(scroller.scrollTop).toBe(300);
    msg.remove();
  });

  it("does not restore against a detached node", () => {
    const scroller = document.createElement("div");
    scroller.scrollTop = 200;
    const msg = document.createElement("div");
    restoreTopMessage(scroller, { el: msg, top: 0 });
    expect(scroller.scrollTop).toBe(200);
  });
});
