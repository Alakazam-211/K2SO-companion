// @vitest-environment jsdom
// "Jump to newest when I send": phone-only, default on (Rosson 2026-10-27).
import { beforeEach, describe, expect, it } from "vitest";
import { JUMP_ON_SEND_KEY, readJumpOnSend, useJumpOnSendStore } from "./jumpOnSend";

beforeEach(() => localStorage.clear());

describe("jumpOnSend", () => {
  it("is on unless turned off", () => {
    expect(readJumpOnSend()).toBe(true);
    localStorage.setItem(JUMP_ON_SEND_KEY, "0");
    expect(readJumpOnSend()).toBe(false);
  });

  it("setOn stores the choice", () => {
    useJumpOnSendStore.getState().setOn(false);
    expect(localStorage.getItem(JUMP_ON_SEND_KEY)).toBe("0");
    expect(useJumpOnSendStore.getState().on).toBe(false);
    useJumpOnSendStore.getState().setOn(true);
    expect(readJumpOnSend()).toBe(true);
  });
});
