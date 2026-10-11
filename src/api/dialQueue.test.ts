// MS26 / MA26: the dial queue — 2 handshakes per server, 4 overall, 4 s
// handshake timeout (a non-grid timeout only frees the slot), 3 failures in
// 3 s back that server off for 8 s while other servers keep dialling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAL_BACKOFF_MS,
  HANDSHAKE_TIMEOUT_MS,
  __resetDialQueueForTests,
  dialBackoffRemainingMs,
  dialsInFlight,
  dialsWaiting,
  queueDial,
} from "./dialQueue";

/** A socket double with real listeners. */
class Sock extends EventTarget {
  static all: Sock[] = [];
  closed = false;
  constructor(public server: string) {
    super();
    Sock.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  fail() {
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("close"));
  }
}

const dial = (server: string, opts?: { failOnTimeout?: boolean }) =>
  queueDial({ id: server }, () => new Sock(server) as unknown as WebSocket, opts);

beforeEach(() => {
  vi.useFakeTimers();
  Sock.all = [];
  __resetDialQueueForTests();
});
afterEach(() => vi.useRealTimers());

describe("dial queue", () => {
  it("a free slot dials synchronously", () => {
    dial("a");
    expect(Sock.all).toHaveLength(1);
    expect(dialsInFlight("a")).toBe(1);
  });

  it("at most 2 handshakes per server; the third waits for a slot", () => {
    dial("b");
    dial("b");
    dial("b");
    expect(Sock.all).toHaveLength(2);
    expect(dialsWaiting()).toBe(1);
    Sock.all[0].open();
    expect(Sock.all).toHaveLength(3);
    expect(dialsInFlight("b")).toBe(2);
  });

  it("at most 4 across all servers; a busy server never blocks the others' share", () => {
    dial("a");
    dial("a");
    dial("b");
    dial("b");
    dial("c");
    expect(Sock.all.map((s) => s.server)).toEqual(["a", "a", "b", "b"]);
    expect(dialsInFlight()).toBe(4);
    Sock.all[2].open(); // a B slot frees: C (waiting) dials
    expect(Sock.all.map((s) => s.server)).toEqual(["a", "a", "b", "b", "c"]);
  });

  it("a non-grid 4 s timeout only frees the slot: no close, no failure", () => {
    for (let i = 0; i < 3; i++) dial("b");
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(Sock.all.every((s) => !s.closed)).toBe(true);
    expect(dialBackoffRemainingMs("b")).toBe(0);
    expect(Sock.all).toHaveLength(3); // the waiter got its slot
  });

  it("a grid timeout counts as a failure (two timeouts + one error → backoff)", () => {
    dial("b", { failOnTimeout: true });
    dial("b", { failOnTimeout: true });
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(dialBackoffRemainingMs("b")).toBe(0);
    dial("b", { failOnTimeout: true });
    Sock.all[2].fail();
    expect(dialBackoffRemainingMs("b")).toBe(DIAL_BACKOFF_MS);
  });

  it("3 failed handshakes in 3 s back THAT server off for 8 s; others dial on", () => {
    for (let i = 0; i < 3; i++) {
      dial("b");
      Sock.all[Sock.all.length - 1].fail();
    }
    expect(dialBackoffRemainingMs("b")).toBe(DIAL_BACKOFF_MS);
    dial("b");
    expect(Sock.all).toHaveLength(3); // B waits out its backoff
    dial("a");
    expect(Sock.all.map((s) => s.server)).toEqual(["b", "b", "b", "a"]);
    vi.advanceTimersByTime(DIAL_BACKOFF_MS);
    expect(Sock.all.map((s) => s.server)).toEqual(["b", "b", "b", "a", "b"]);
  });

  it("a constructor throw is a failure; a cancelled waiter never dials", () => {
    queueDial({ id: "b" }, () => {
      throw new Error("Insufficient resources");
    });
    expect(dialsInFlight("b")).toBe(0);
    dial("b");
    dial("b");
    const t = dial("b");
    t.cancel();
    Sock.all[0].open();
    expect(Sock.all).toHaveLength(2);
    expect(dialsWaiting()).toBe(0);
  });
});
