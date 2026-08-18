import { describe, expect, it } from "vitest";

import { reconnectDelayMs, RECONNECT_CAP_MS } from "../lib/reconnect";
import {
  CONNECTING_STALL_MS,
  GRID_ACK_PROBE_MS,
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
  shouldHealConnectingStall,
  shouldHealOpenStall,
  shouldProbeAck,
  shouldResyncOnForeground,
  shouldSkipConnectingResync,
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

describe("shouldSkipConnectingResync", () => {
  const fresh = {
    readyState: WS_CONNECTING,
    dialStartedAt: 1_000,
    now: 1_000 + CONNECTING_STALL_MS - 1,
    reason: "need-to-send",
  };

  it("skips a fresh CONNECTING dial so the first send does not abort it", () => {
    expect(shouldSkipConnectingResync(fresh)).toBe(true);
    expect(shouldSkipConnectingResync({ ...fresh, reason: "foreground" })).toBe(
      true,
    );
  });

  it("does not skip after the 5s deadline or on reload", () => {
    expect(
      shouldSkipConnectingResync({
        ...fresh,
        now: 1_000 + CONNECTING_STALL_MS,
      }),
    ).toBe(false);
    expect(shouldSkipConnectingResync({ ...fresh, reason: "reload" })).toBe(
      false,
    );
    expect(
      shouldSkipConnectingResync({ ...fresh, readyState: WS_OPEN }),
    ).toBe(false);
  });
});

describe("shouldHealConnectingStall", () => {
  it("heals a hung CONNECTING dial after 5s while visible", () => {
    expect(
      shouldHealConnectingStall({
        visible: true,
        readyState: WS_CONNECTING,
        dialStartedAt: 1_000,
        now: 1_000 + CONNECTING_STALL_MS,
      }),
    ).toBe(true);
    expect(
      shouldHealConnectingStall({
        visible: true,
        readyState: WS_CONNECTING,
        dialStartedAt: 1_000,
        now: 1_000 + CONNECTING_STALL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldHealConnectingStall({
        visible: false,
        readyState: WS_CONNECTING,
        dialStartedAt: 1_000,
        now: 1_000 + CONNECTING_STALL_MS,
      }),
    ).toBe(false);
  });
});

describe("shouldProbeAck", () => {
  const base = {
    visible: true,
    readyState: WS_OPEN,
    k1WireActive: true,
    lastAckVersion: 7,
    lastFrameAt: 1_000,
    lastAckProbeAt: 0,
    now: 1_000 + GRID_ACK_PROBE_MS,
  };

  it("re-sends the last ack after 15s OPEN silence", () => {
    expect(shouldProbeAck(base)).toBe(true);
    expect(
      shouldProbeAck({ ...base, now: 1_000 + GRID_ACK_PROBE_MS - 1 }),
    ).toBe(false);
    expect(shouldProbeAck({ ...base, lastAckVersion: 0 })).toBe(false);
    expect(shouldProbeAck({ ...base, k1WireActive: false })).toBe(false);
  });
});

describe("socketIsOpen", () => {
  it("is true only for OPEN", () => {
    expect(socketIsOpen(WS_OPEN)).toBe(true);
    expect(socketIsOpen(WS_CONNECTING)).toBe(false);
    expect(socketIsOpen(null)).toBe(false);
  });
});
