import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reviveMock, refreshGateMock, noteLinkMock, gateListeners } = vi.hoisted(() => ({
  reviveMock: vi.fn(),
  refreshGateMock: vi.fn(),
  noteLinkMock: vi.fn(),
  gateListeners: new Set<(id: string, g: { offered: boolean }) => void>(),
}));
vi.mock("../lib/revive", () => ({ revive: reviveMock }));
vi.mock("./homeChat", () => ({
  refreshHomeChatGate: refreshGateMock,
  noteHomeChatLink: noteLinkMock,
  onHomeChatGate: (fn: (id: string, g: { offered: boolean }) => void) => {
    gateListeners.add(fn);
    return () => gateListeners.delete(fn);
  },
}));

import { fakeScope } from "../test/fakeScope";
import { __resetDialQueueForTests } from "./dialQueue";
import { emitServerSignal, onServerSignal, type ServerSignal } from "./serverSignals";
import {
  HOME_CHAT_EVENTS_SLOW_RETRY_MS,
  __resetHomeChatEventsForTests,
  homeChatEventsUrl,
  homeChatLinkUp,
  homeChatRetryMs,
  parseHomeChatFrame,
  subscribeHomeChat,
  type HomeChatFrame,
  type HomeChatLinkInfo,
} from "./homeChatEvents";

class MockWS {
  static instances: MockWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(v: unknown) {
    this.onmessage?.({ data: typeof v === "string" ? v : JSON.stringify(v) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => MockWS.instances[MockWS.instances.length - 1];

let signals: Array<[string, ServerSignal]> = [];
let stopSignals = () => {};

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // jitter → the full pause
  reviveMock.mockReset();
  refreshGateMock.mockReset();
  noteLinkMock.mockReset();
  gateListeners.clear();
  __resetDialQueueForTests();
  signals = [];
  stopSignals = onServerSignal((id, s) => signals.push([id, s]));
});

afterEach(() => {
  __resetHomeChatEventsForTests();
  stopSignals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("frames", () => {
  const sewMsg = { id: "1001", channel_id: "55", author_id: "77", body: "hi", created_at: "2026-11-15T10:00:00Z" };

  it("hello: chat, flags, rings in progress, every call", () => {
    const f = parseHomeChatFrame(
      JSON.stringify({
        type: "hello",
        chat: "live",
        flags: { httpTyping: true, callCancel: true, other: true },
        calls: [
          { callId: "4242", conv: "55", startedBy: "77", ringing: true, silent: false, expiresAt: "2026-11-15T10:00:45Z", call: { id: "4242", channel_id: "55", state: "ringing" } },
          { callId: "4243", conv: "56", ringing: false },
          { callId: "vc_x", conv: "57", ringing: true },
          "junk",
        ],
      })
    );
    expect(f?.type).toBe("hello");
    if (f?.type !== "hello") return;
    expect(f.chat).toBe("live");
    expect(f.flags).toMatchObject({ httpTyping: true, callCancel: true, readStateUnreadCount: false });
    expect(f.rings.map((r) => r.callId)).toEqual(["4242"]);
    expect(f.calls.map((c) => c.ring.callId)).toEqual(["4242", "4243"]);
    expect(f.calls[0].call?.state).toBe("ringing");
  });

  it("every chat frame type", () => {
    const cases: Array<[unknown, HomeChatFrame | null]> = [
      [{ type: "status", chat: "unavailable" }, { type: "status", chat: "unavailable" }],
      [{ type: "deleted", conv: "55", id: 1001 }, { type: "deleted", conv: "55", id: "1001" }],
      [{ type: "read", conv: "55" }, { type: "read", conv: "55" }],
      [{ type: "member_removed", conv: "55" }, { type: "member_removed", conv: "55" }],
      [{ type: "summary_changed" }, { type: "summary_changed", conv: null }],
      [{ type: "summary_changed", conv: "55" }, { type: "summary_changed", conv: "55" }],
      [{ type: "typing", conv: "55", member: "77" }, { type: "typing", conv: "55", member: "77" }],
      [
        { type: "reaction", conv: "55", msg: "1001", emoji: { kind: "unicode", value: "👍" }, on: true, count: 2, member: "77", mine: false },
        { type: "reaction", conv: "55", msg: "1001", emoji: "👍", on: true, count: 2, member: "77", mine: false },
      ],
      [
        { type: "reaction", conv: "55", msg: "1001", emoji: "🎉", on: false, count: null, member: null, mine: true },
        { type: "reaction", conv: "55", msg: "1001", emoji: "🎉", on: false, count: 0, member: null, mine: true },
      ],
    ];
    for (const [raw, want] of cases) expect(parseHomeChatFrame(JSON.stringify(raw))).toEqual(want);
    const m = parseHomeChatFrame({ type: "message", conv: "55", message: sewMsg });
    expect(m).toMatchObject({ type: "message", conv: "55", message: { id: "1001", authorId: "77" } });
    const u = parseHomeChatFrame({ type: "message_updated", conv: "55", message: { ...sewMsg, call: { call_id: "4242", end_reason: "no_answer" } } });
    expect(u).toMatchObject({ type: "message_updated", message: { call: { callId: "4242", ended: true } } });
  });

  it("call frames: Sew's d as is", () => {
    expect(
      parseHomeChatFrame({ type: "call_ring", conv: "55", d: { call_id: "4242", channel_id: "55", started_by: "77", ringing: false, silent: false, reason: "accepted" } })
    ).toMatchObject({ type: "call_ring", conv: "55", ring: { callId: "4242", ringing: false, reason: "accepted" } });
    expect(
      parseHomeChatFrame({ type: "call_updated", conv: "55", d: { call: { id: "4242", channel_id: "55", state: "ended", end_reason: "declined", participant_ids: ["77"], rings: [{ member_id: "88", state: "declined" }] } } })
    ).toMatchObject({ type: "call_updated", call: { callId: "4242", ended: true, rings: [{ memberId: "88", state: "declined" }] } });
  });

  it("junk and unknown frames are dropped", () => {
    const junk: unknown[] = [
      "not json",
      "[]",
      "null",
      42,
      null,
      { type: "nope" },
      { conv: "55" },
      { type: "message", conv: "55", message: { body: "no id" } },
      { type: "deleted", conv: "55" },
      { type: "read" },
      { type: "typing", conv: "55" },
      { type: "reaction", conv: "55", msg: "1", emoji: { kind: "custom", id: "9" } },
      { type: "call_ring", d: { call_id: "vc_x", channel_id: "55" } },
      { type: "call_updated", d: {} },
    ];
    for (const j of junk) expect(parseHomeChatFrame(typeof j === "object" && j !== null ? JSON.stringify(j) : j)).toBeNull();
  });

  it("url and schedule", () => {
    expect(homeChatEventsUrl("wss://a.k2.dev/", "t k")).toBe("wss://a.k2.dev/cli/home-chat/events?token=t+k");
    expect(homeChatEventsUrl("https://a.k2.dev", "t")).toBe("wss://a.k2.dev/cli/home-chat/events?token=t");
    expect(homeChatEventsUrl("", "t")).toBeNull();
    expect(homeChatEventsUrl("wss://a", "")).toBeNull();
    expect([0, 1, 2, 3, 4, 9].map(homeChatRetryMs)).toEqual([2_000, 5_000, 15_000, 30_000, 30_000, 30_000]);
  });
});

describe("the shared socket", () => {
  it("one socket per server for every subscriber, on that server's token", () => {
    const a = fakeScope({ id: "a", base: "https://a.k2.dev", token: "tok-a" });
    const b = fakeScope({ id: "b", base: "https://b.k2.dev", token: "tok-b" });
    const got1: HomeChatFrame[] = [];
    const got2: HomeChatFrame[] = [];
    const un1 = subscribeHomeChat(a, (f) => got1.push(f));
    const un2 = subscribeHomeChat(a, (f) => got2.push(f));
    const unB = subscribeHomeChat(b, () => {});
    expect(MockWS.instances.map((w) => w.url)).toEqual([
      "wss://a.k2.dev/cli/home-chat/events?token=tok-a",
      "wss://b.k2.dev/cli/home-chat/events?token=tok-b",
    ]);
    const ws = MockWS.instances[0];
    ws.openNow();
    expect(homeChatLinkUp("a")).toBe(true);
    ws.frame({ type: "read", conv: "55" });
    ws.frame("garbage");
    expect(got1).toEqual([{ type: "read", conv: "55" }]);
    expect(got2).toEqual(got1);
    un1();
    expect(ws.closed).toBe(false);
    un2();
    expect(ws.closed).toBe(true);
    expect(homeChatLinkUp("a")).toBe(false);
    un1(); // twice is harmless
    unB();
  });

  it("a late subscriber hears the link is up; hello feeds the gate's flags", () => {
    const s = fakeScope({ id: "a" });
    const un1 = subscribeHomeChat(s, () => {});
    last().openNow();
    const links: HomeChatLinkInfo[] = [];
    const un2 = subscribeHomeChat(s, () => {}, { onLink: (i) => links.push(i) });
    expect(links).toEqual([{ up: true, reopened: false }]);
    last().frame({ type: "hello", chat: "live", flags: { httpTyping: true }, calls: [] });
    expect(noteLinkMock).toHaveBeenCalledWith(s, expect.objectContaining({ chat: "live", flags: expect.objectContaining({ httpTyping: true }) }));
    last().frame({ type: "status", chat: "unavailable" });
    expect(noteLinkMock).toHaveBeenLastCalledWith(s, { chat: "unavailable" });
    un1();
    un2();
  });

  it("a drop reconnects 2 s, 5 s, 15 s, 30 s; the reopen says so", async () => {
    const s = fakeScope({ id: "a" });
    const links: HomeChatLinkInfo[] = [];
    const un = subscribeHomeChat(s, () => {}, { onLink: (i) => links.push(i) });
    last().openNow();
    last().drop(1006);
    expect(links).toEqual([
      { up: true, reopened: false },
      { up: false, reopened: false },
    ]);
    for (const pause of [2_000, 5_000, 15_000, 30_000, 30_000]) {
      const before = MockWS.instances.length;
      await vi.advanceTimersByTimeAsync(pause - 1);
      expect(MockWS.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWS.instances.length).toBe(before + 1);
      last().openNow();
      last().drop(1006);
    }
    expect(links.filter((l) => l.up).every((l, i) => l.reopened === i > 0)).toBe(true);
    un();
  });

  it("a socket that stayed open 30 s starts the backoff over", async () => {
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().openNow();
    last().drop();
    await vi.advanceTimersByTimeAsync(2_000);
    last().openNow();
    last().drop();
    await vi.advanceTimersByTimeAsync(5_000);
    last().openNow();
    await vi.advanceTimersByTimeAsync(30_000);
    last().drop();
    const before = MockWS.instances.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWS.instances.length).toBe(before + 1);
    un();
  });

  it("4 dials that never open re-read the gate: chat off parks it until the gate opens", async () => {
    refreshGateMock.mockResolvedValue({ offered: false, refusal: null });
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().drop(1006); // dead 1
    for (const pause of [2_000, 5_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(pause);
      last().drop(1006);
    }
    expect(MockWS.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshGateMock).toHaveBeenCalledWith(s, { force: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(MockWS.instances).toHaveLength(4);
    for (const fn of gateListeners) fn("a", { offered: true });
    expect(MockWS.instances).toHaveLength(5);
    un();
  });

  it("…while a blip only slows it to once a minute", async () => {
    refreshGateMock.mockResolvedValue({ offered: true, refusal: { kind: "network" } });
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().drop(1006);
    for (const pause of [2_000, 5_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(pause);
      last().drop(1006);
    }
    await vi.advanceTimersByTimeAsync(HOME_CHAT_EVENTS_SLOW_RETRY_MS - 1);
    expect(MockWS.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWS.instances).toHaveLength(5);
    un();
  });

  it("4003: whoami on this server, then a reconnect while the login stands", async () => {
    reviveMock.mockResolvedValue("still-valid");
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().openNow();
    last().drop(4003);
    await vi.advanceTimersByTimeAsync(0);
    expect(reviveMock).toHaveBeenCalledWith(s, { background: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWS.instances).toHaveLength(2);
    un();
  });

  it("4003 with a dead login: stops, signals sign-in, and redials on `recovered`", async () => {
    reviveMock.mockResolvedValue("signin-required");
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().openNow();
    last().drop(4003);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(MockWS.instances).toHaveLength(1);
    expect(signals).toContainEqual(["a", "signin"]);
    emitServerSignal("a", "recovered");
    expect(MockWS.instances).toHaveLength(2);
    un();
  });

  it("unsubscribe stops every timer; a removed server never dials", async () => {
    const s = fakeScope({ id: "a" });
    const un = subscribeHomeChat(s, () => {});
    last().openNow();
    last().drop();
    un();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(MockWS.instances).toHaveLength(1);
    const gone = fakeScope({ id: "g" });
    gone.remove();
    const un2 = subscribeHomeChat(gone, () => {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(MockWS.instances).toHaveLength(1);
    expect(homeChatLinkUp("g")).toBe(false);
    un2();
  });

  it("a subscriber that throws never breaks the others", () => {
    const s = fakeScope({ id: "a" });
    const got: string[] = [];
    const un1 = subscribeHomeChat(s, () => {
      throw new Error("boom");
    });
    const un2 = subscribeHomeChat(s, (f) => got.push(f.type));
    last().openNow();
    last().frame({ type: "read", conv: "1" });
    expect(got).toEqual(["read"]);
    un1();
    un2();
  });
});
