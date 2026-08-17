import { describe, expect, it } from "vitest";

import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  reconnectDelayMs,
} from "./reconnect";

describe("reconnectDelayMs", () => {
  it("is 500 · 2^min(n,4) capped at 5s", () => {
    expect([0, 1, 2, 3, 4].map(reconnectDelayMs)).toEqual([
      500, 1000, 2000, 4000, 5000,
    ]);
    expect(reconnectDelayMs(5)).toBe(RECONNECT_CAP_MS);
    expect(reconnectDelayMs(100)).toBe(RECONNECT_CAP_MS);
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_MS);
  });
});
