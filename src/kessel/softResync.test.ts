import { describe, expect, it } from "vitest";

import { reconnectDelayMs, RECONNECT_CAP_MS } from "../lib/reconnect";
import {
  GRID_STALL_NO_FRAME_MS,
  OUTBOUND_BUFFER_CAP,
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  enqueueOutbound,
  isAckAction,
  reconnectDelayMs as healBackoffMs,
  shouldBufferAndResync,
  shouldHealOpenStall,
  shouldResyncOnForeground,
  socketIsOpen,
} from "./softResync";

describe("shouldResyncOnForeground", () => {
  it("fires when visible and the socket is not OPEN", () => {
    expect(
      shouldResyncOnForeground({ visible: true, readyState: WS_CLOSED }),
    ).toBe(true);
    expect(
      shouldResyncOnForeground({ visible: true, readyState: WS_CLOSING }),
    ).toBe(true);
    expect(shouldResyncOnForeground({ visible: true, readyState: null })).toBe(
      true,
    );
    expect(
      shouldResyncOnForeground({ visible: true, readyState: undefined }),
    ).toBe(true);
  });

  it("is a no-op while hidden, OPEN, or already CONNECTING", () => {
    expect(
      shouldResyncOnForeground({ visible: false, readyState: WS_CLOSED }),
    ).toBe(false);
    expect(
      shouldResyncOnForeground({ visible: true, readyState: WS_OPEN }),
    ).toBe(false);
    expect(
      shouldResyncOnForeground({ visible: true, readyState: WS_CONNECTING }),
    ).toBe(false);
  });
});

describe("shouldBufferAndResync", () => {
  it("buffers outbound on a non-OPEN socket", () => {
    expect(
      shouldBufferAndResync({ readyState: WS_CLOSED, action: "input" }),
    ).toBe(true);
    expect(
      shouldBufferAndResync({ readyState: WS_CONNECTING, action: "set_mode" }),
    ).toBe(true);
    expect(
      shouldBufferAndResync({ readyState: null, action: "set_active" }),
    ).toBe(true);
  });

  it("does not buffer acks or anything while OPEN", () => {
    expect(
      shouldBufferAndResync({ readyState: WS_CLOSED, action: "ack" }),
    ).toBe(false);
    expect(
      shouldBufferAndResync({ readyState: WS_OPEN, action: "input" }),
    ).toBe(false);
    expect(isAckAction({ action: "ack", version: 3 })).toBe(true);
    expect(isAckAction({ action: "input", text: "x" })).toBe(false);
  });
});

describe("shouldHealOpenStall", () => {
  const base = {
    visible: true,
    readyState: WS_OPEN,
    lastFrameAt: 1_000,
    now: 1_000 + GRID_STALL_NO_FRAME_MS,
    healedThisEpisode: false,
  };

  it("heals OPEN + no frame ≥ 20s while visible", () => {
    expect(shouldHealOpenStall(base)).toBe(true);
    expect(
      shouldHealOpenStall({ ...base, now: 1_000 + GRID_STALL_NO_FRAME_MS - 1 }),
    ).toBe(false);
  });

  it("does not heal while hidden, not OPEN, never-framed, or already healed", () => {
    expect(shouldHealOpenStall({ ...base, visible: false })).toBe(false);
    expect(shouldHealOpenStall({ ...base, readyState: WS_CLOSED })).toBe(false);
    expect(shouldHealOpenStall({ ...base, lastFrameAt: 0 })).toBe(false);
    expect(shouldHealOpenStall({ ...base, healedThisEpisode: true })).toBe(
      false,
    );
  });
});

describe("enqueueOutbound", () => {
  it("drops the oldest when the cap is hit", () => {
    let q: number[] = [];
    for (let i = 0; i < OUTBOUND_BUFFER_CAP + 3; i++) {
      q = enqueueOutbound(q, i);
    }
    expect(q).toHaveLength(OUTBOUND_BUFFER_CAP);
    expect(q[0]).toBe(3);
    expect(q[q.length - 1]).toBe(OUTBOUND_BUFFER_CAP + 2);
  });
});

describe("backoff", () => {
  it("keeps 500 · 2^min(n,4) cap 5s", () => {
    expect(healBackoffMs).toBe(reconnectDelayMs);
    expect([0, 1, 2, 3, 4].map(reconnectDelayMs)).toEqual([
      500, 1000, 2000, 4000, 5000,
    ]);
    expect(reconnectDelayMs(9)).toBe(RECONNECT_CAP_MS);
  });
});

describe("socketIsOpen", () => {
  it("is true only for OPEN", () => {
    expect(socketIsOpen(WS_OPEN)).toBe(true);
    expect(socketIsOpen(WS_CONNECTING)).toBe(false);
    expect(socketIsOpen(null)).toBe(false);
  });
});
