// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));

import { callShim } from "./callShim";
import { formatCallDuration, useCallDuration } from "./callDuration";
import {
  __resetVoiceCallForTests,
  __setCallShimForTests,
  CALL_START_KEY,
  setPhoneVoiceEngine,
  useVoiceCall,
  type EngineEvents,
  type EngineNow,
  type PhoneVoiceEngine,
} from "./voiceCall";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** Sew's plugin as the store sees it: Rust drives the system call. */
function nativeEngine() {
  let events: EngineEvents | null = null;
  let now: EngineNow | null = null;
  const engine: PhoneVoiceEngine = {
    available: true,
    drivesSystemCall: true,
    join: vi.fn(async (_s, _r, e: EngineEvents) => {
      events = e;
    }),
    resync: vi.fn(async (e: EngineEvents) => {
      events = e;
      return now;
    }),
    leave: vi.fn(async () => {}),
    setMuted: () => {},
    system: () => {},
  };
  return {
    engine,
    state: (s: Parameters<EngineEvents["onState"]>[0], reason?: string) => act(() => events?.onState(s, reason)),
    answer: (next: EngineNow | null) => void (now = next),
  };
}

async function join(e: ReturnType<typeof nativeEngine>) {
  setPhoneVoiceEngine(e.engine);
  await act(() => useVoiceCall.getState().join(ROOM));
}

const startedAt = () => useVoiceCall.getState().startedAt;
const saved = () => JSON.parse(sessionStorage.getItem(CALL_START_KEY) ?? "null");
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const LIVE: EngineNow = { state: "connected", serverId: "s1", roomId: "room-1", muted: false, consent: null };

/** What a webview reload leaves: the engine's call, the page's state gone,
 *  sessionStorage kept. */
function reload() {
  useVoiceCall.setState({ phase: "idle", room: null, startedAt: null });
}

function Clock() {
  return <span data-testid="clock">{useCallDuration() ?? "none"}</span>;
}
const clock = () => screen.getByTestId("clock").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  sessionStorage.clear();
  __resetVoiceCallForTests();
  __setCallShimForTests({ ...callShim(), microphone: async () => "granted" as const, label: () => {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __setCallShimForTests(callShim());
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("the call's time", () => {
  it("formats m:ss under an hour, h:mm:ss after", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(999)).toBe("0:00");
    expect(formatCallDuration(5_000)).toBe("0:05");
    expect(formatCallDuration(65_000)).toBe("1:05");
    expect(formatCallDuration(754_000)).toBe("12:34");
    expect(formatCallDuration(3_599_999)).toBe("59:59");
    expect(formatCallDuration(3_600_000)).toBe("1:00:00");
    expect(formatCallDuration(3_723_000)).toBe("1:02:03");
    expect(formatCallDuration(36_000_000)).toBe("10:00:00");
    // A clock that stepped back never shows a negative time.
    expect(formatCallDuration(-4_000)).toBe("0:00");
  });

  it("starts at the call's first connect, not at Join", async () => {
    const e = nativeEngine();
    render(<Clock />);
    await join(e);
    expect(startedAt()).toBeNull();
    at(3_000);
    e.state("connecting");
    expect(startedAt()).toBeNull();
    expect(clock()).toBe("none");
    at(4_000);
    e.state("connected");
    expect(startedAt()).toBe(T0 + 4_000);
    expect(saved()).toEqual({ serverId: "s1", roomId: "room-1", at: T0 + 4_000 });
    expect(clock()).toBe("0:00");
    act(() => vi.advanceTimersByTime(65_000));
    expect(clock()).toBe("1:05");
  });

  it("keeps running through a reconnect", async () => {
    const e = nativeEngine();
    render(<Clock />);
    await join(e);
    e.state("connected");
    act(() => vi.advanceTimersByTime(30_000));
    e.state("reconnecting");
    expect(useVoiceCall.getState().phase).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(10_000));
    expect(clock()).toBe("0:40");
    e.state("connected");
    expect(startedAt()).toBe(T0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(clock()).toBe("0:45");
  });

  it("back in the foreground (resync), the same call keeps its time", async () => {
    const e = nativeEngine();
    await join(e);
    e.state("connected");
    at(90_000);
    e.answer(LIVE);
    await act(() => useVoiceCall.getState().resync());
    expect(startedAt()).toBe(T0);
  });

  it("survives a webview reload: the call taken back keeps its start", async () => {
    const e = nativeEngine();
    await join(e);
    at(2_000);
    e.state("connected");
    at(600_000);
    reload();
    e.answer({ ...LIVE, state: "reconnecting" });
    render(<Clock />);
    await act(() => useVoiceCall.getState().resync());
    expect(useVoiceCall.getState().phase).toBe("reconnecting");
    expect(startedAt()).toBe(T0 + 2_000);
    expect(clock()).toBe("9:58");
    e.state("connected");
    expect(startedAt()).toBe(T0 + 2_000);
  });

  it("a reload with nothing kept for that call starts from now; never another room's start", async () => {
    sessionStorage.setItem(CALL_START_KEY, JSON.stringify({ serverId: "s1", roomId: "room-2", at: T0 - 500_000 }));
    const e = nativeEngine();
    setPhoneVoiceEngine(e.engine);
    e.answer(LIVE);
    at(10_000);
    await act(() => useVoiceCall.getState().resync());
    expect(startedAt()).toBe(T0 + 10_000);
    expect(saved()).toEqual({ serverId: "s1", roomId: "room-1", at: T0 + 10_000 });
  });

  it("a held join (the recording notice) has no time yet", async () => {
    const e = nativeEngine();
    setPhoneVoiceEngine(e.engine);
    e.answer({ ...LIVE, state: "held" });
    await act(() => useVoiceCall.getState().resync());
    expect(useVoiceCall.getState().phase).toBe("joining");
    expect(startedAt()).toBeNull();
  });

  it("resets for a new call; the end forgets the kept start", async () => {
    const e = nativeEngine();
    render(<Clock />);
    await join(e);
    e.state("connected");
    at(300_000);
    e.state("ended", "left");
    expect(startedAt()).toBeNull();
    expect(saved()).toBeNull();
    expect(clock()).toBe("none");
    await join(e);
    expect(startedAt()).toBeNull();
    at(301_000);
    e.state("connected");
    expect(startedAt()).toBe(T0 + 301_000);
    expect(clock()).toBe("0:00");
    // Join elsewhere while in a call: the old call leaves, the new one starts over.
    at(400_000);
    await act(() => useVoiceCall.getState().join({ ...ROOM, roomId: "room-2" }));
    expect(startedAt()).toBeNull();
    expect(saved()).toBeNull();
  });

  it("ticks once a second only while the page is in front", async () => {
    const e = nativeEngine();
    render(<Clock />);
    await join(e);
    e.state("connected");
    act(() => vi.advanceTimersByTime(3_000));
    expect(clock()).toBe("0:03");
    expect(vi.getTimerCount()).toBe(1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(20_000));
    expect(clock()).toBe("0:03");
    // Back in front: caught up at once, ticking again.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(clock()).toBe("0:23");
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
