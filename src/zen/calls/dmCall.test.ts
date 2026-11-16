import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../api/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/scope")>()),
  scopeFor: (id: string) => ({ id, label: `box-${id}` }),
}));

const api = vi.hoisted(() => ({
  gate: { offered: true, feature: true, refusal: null as null | { kind: string }, flags: { callCancel: true } },
  homeChatGateNow: vi.fn(),
  homeChatGateStale: vi.fn((..._a: unknown[]) => false),
  refreshHomeChatGate: vi.fn(),
  cancelDmCall: vi.fn(),
  declineDmCall: vi.fn(),
  ringDmCallAgain: vi.fn(),
  leaveDmCall: vi.fn(async (..._a: unknown[]) => ({ ok: true, left: true, already: false, why: null, room: null })),
  fetchHomeChatPeople: vi.fn(async (..._a: unknown[]) => ({
    ok: true,
    me: { ext: "k2:owner", memberId: "100" },
    people: [{ ext: "k2:connect:a", username: "alex", displayName: "Alex Kim", picture: null, role: null, ready: true, memberId: "200" }],
  })),
  openHomeChatDm: vi.fn(),
}));
vi.mock("../../api/homeChat", () => ({
  homeChatGateNow: (...a: unknown[]) => api.homeChatGateNow(...a),
  homeChatGateStale: (...a: unknown[]) => api.homeChatGateStale(...a),
  refreshHomeChatGate: (...a: unknown[]) => api.refreshHomeChatGate(...a),
  cancelDmCall: (...a: unknown[]) => api.cancelDmCall(...a),
  declineDmCall: (...a: unknown[]) => api.declineDmCall(...a),
  ringDmCallAgain: (...a: unknown[]) => api.ringDmCallAgain(...a),
  leaveDmCall: (...a: unknown[]) => api.leaveDmCall(...a),
  fetchHomeChatPeople: (...a: unknown[]) => api.fetchHomeChatPeople(...a),
  openHomeChatDm: (...a: unknown[]) => api.openHomeChatDm(...a),
}));

import { parseCall, parseRing, type HomeChatCall, type HomeChatRing } from "../../api/homeChatCallsPure";
import type { CallShim } from "../voice/callShim";
import {
  __resetVoiceCallForTests,
  __setCallShimForTests,
  setPhoneVoiceEngine,
  useVoiceCall,
  type EngineEvents,
  type PhoneVoiceEngine,
} from "../voice/voiceCall";
import {
  CALL_ENDED_SHOW_MS,
  RING_AGAIN_MAX,
  __resetDmCallsForTests,
  __setDmIdsSourceForTests,
  acceptRing,
  callAgainDmCall,
  callPersonFromRow,
  canRingAgain,
  cancelOutgoingDmCall,
  declineRing,
  noteCallPush,
  onHomeChatCallFrame,
  phaseFromCall,
  routeCallTap,
  startDmCall,
  useDmCalls,
} from "./dmCall";
import { __resetHomeChatOpenForTests, useHomeChatOpenRequest } from "./homeChatOpen";

// ─── Fakes ───

const order: string[] = [];

function shim(): CallShim {
  return {
    label: () => {},
    start: vi.fn(async () => null),
    report: () => {},
    setMuted: () => {},
    setTitle: () => {},
    end: () => {},
    setSpeaker: async () => null,
    microphone: vi.fn(async () => "granted" as const),
    listen: () => () => {},
  };
}

let events: EngineEvents | null = null;
let refuseWith: unknown = null;
const engine: PhoneVoiceEngine & { joins: Array<[string, string]> } = {
  available: true,
  drivesSystemCall: true,
  joins: [],
  join: vi.fn(async (serverId: string, roomId: string, e: EngineEvents) => {
    order.push(`join:${roomId}`);
    engine.joins.push([serverId, roomId]);
    events = e;
    if (refuseWith) throw refuseWith;
  }),
  leave: vi.fn(async () => {
    order.push("leave");
  }),
  setMuted: () => {},
  system: () => {},
};

let nativeIds: { room: string; dm: string; callId: string | null; sewCallId: string | null } | null = null;

function ring(over: Partial<Record<string, unknown>> = {}): HomeChatRing {
  return parseRing({
    call_id: "4455",
    channel_id: "900",
    started_by: "200",
    ringing: true,
    silent: false,
    expires_at: new Date(Date.now() + 45_000).toISOString(),
    ...over,
  })!;
}

function call(over: Partial<Record<string, unknown>> = {}): HomeChatCall {
  return parseCall({
    call: {
      id: "4455",
      channel_id: "900",
      started_by: "100",
      state: "ringing",
      participant_ids: ["100"],
      rings: [{ member_id: "200", state: "ringing" }],
      ...over,
    },
  })!;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  order.length = 0;
  events = null;
  refuseWith = null;
  engine.joins = [];
  nativeIds = { room: "dm:900", dm: "900", callId: "vc_abc", sewCallId: "4455" };
  __resetVoiceCallForTests();
  __setCallShimForTests(shim());
  setPhoneVoiceEngine(engine);
  __resetDmCallsForTests();
  __resetHomeChatOpenForTests();
  __setDmIdsSourceForTests({ read: async () => nativeIds, listen: () => () => {} });
  api.gate = { offered: true, feature: true, refusal: null, flags: { callCancel: true } };
  api.homeChatGateNow.mockImplementation(() => api.gate);
  api.refreshHomeChatGate.mockImplementation(async () => api.gate);
  api.cancelDmCall.mockReset().mockImplementation(async () => {
    order.push("cancel");
    return { ok: true, cancelled: true, via: "cancel", callId: "4455", hint: null };
  });
  api.declineDmCall.mockReset().mockResolvedValue({ ok: true, declined: true });
  api.ringDmCallAgain.mockReset().mockResolvedValue({ ok: true, rung: true });
  api.leaveDmCall.mockClear();
  api.openHomeChatDm.mockReset();
  vi.mocked(engine.join).mockClear();
  vi.mocked(engine.leave).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  __setDmIdsSourceForTests(null);
});

// ─── Calling ───

describe("startDmCall", () => {
  it("joins the DM as the room dm:<conv> and keeps K2's and Sew's ids apart", async () => {
    const out = await startDmCall("s1", "900", { name: "Alex" });
    expect(out).toEqual({ ok: true });
    expect(engine.joins).toEqual([["s1", "dm:900"]]);
    expect(useVoiceCall.getState().room).toMatchObject({ roomId: "dm:900", roomName: "Alex", dm: { conv: "900" } });
    const a = useDmCalls.getState().active!;
    expect(a).toMatchObject({ role: "caller", phase: "ringing", k2CallId: "vc_abc", sewCallId: "4455", serverLabel: "box-s1" });
  });

  it("refuses swapped ids from the native side", async () => {
    nativeIds = { room: "dm:900", dm: "900", callId: "4455", sewCallId: "vc_abc" };
    await startDmCall("s1", "900", { name: "Alex" });
    expect(useDmCalls.getState().active).toMatchObject({ k2CallId: null, sewCallId: null });
    // Sew's id then comes from the first call_updated.
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call() });
    expect(useDmCalls.getState().active?.sewCallId).toBe("4455");
  });

  it("follows the other side: busy, then answered", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ rings: [{ member_id: "200", state: "busy" }] }) });
    expect(useDmCalls.getState().active?.phase).toBe("busy");
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ state: "active", participant_ids: ["100", "200"] }) });
    expect(useDmCalls.getState().active?.phase).toBe("connected");
  });

  it("a server that doesn't offer Home chat gets a line, and no join", async () => {
    api.gate = { offered: false, feature: false, refusal: null, flags: { callCancel: false } };
    const out = await startDmCall("s1", "900", { name: "Alex" });
    expect(out).toMatchObject({ ok: false, raw: "not_supported" });
    expect(engine.join).not.toHaveBeenCalled();
    expect(useDmCalls.getState().notice?.text).toMatch(/older K2 that can't make calls/);
  });

  it.each([
    ["host_not_pro", "Calls need the Pro plan on that server.", false],
    ["voice_unavailable", "Calls on box-s1 are restarting. Try again in a moment.", true],
    ["chat_unavailable", "Calls aren't available on box-s1 right now.", false],
    ["dm_not_found", "Your conversation with Alex isn't on box-s1.", false],
  ])("the gate %s reads as a plain line", async (raw, text, retry) => {
    refuseWith = { code: raw === "host_not_pro" || raw === "voice_unavailable" ? raw : "unknown", hint: "", raw };
    const out = await startDmCall("s1", "900", { name: "Alex" });
    expect(out).toMatchObject({ ok: false, raw });
    expect(useDmCalls.getState().active).toBeNull();
    const n = useDmCalls.getState().notice!;
    expect(n.text).toBe(text);
    expect(n.retry).toEqual(retry ? { serverId: "s1", conv: "900", name: "Alex" } : null);
    // Said once, where the person is: not again on the call screen.
    expect(useVoiceCall.getState().notice).toBeNull();
  });

  it("ends a voice room you're in first (one voice entry per person)", async () => {
    await useVoiceCall.getState().join({ serverId: "s1", serverLabel: "box", roomId: "room-1", roomName: "Standup", limit: 9 });
    order.length = 0;
    await startDmCall("s1", "900", { name: "Alex" });
    expect(order).toEqual(["leave", "join:dm:900"]);
  });

  it("calling the same DM again while it rings changes nothing", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    await startDmCall("s1", "900", { name: "Alex" });
    expect(engine.join).toHaveBeenCalledTimes(1);
  });

  it("a bad conversation id never reaches the engine", async () => {
    await startDmCall("s1", "vc_1", { name: "Alex" });
    expect(engine.join).not.toHaveBeenCalled();
  });
});

describe("the caller's Cancel and Call again", () => {
  it("cancels with Sew's id, then lets the media go", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    order.length = 0;
    await cancelOutgoingDmCall();
    expect(api.cancelDmCall).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "900", "4455");
    // Cancel first: a leave first would read as an unanswered call.
    expect(order).toEqual(["cancel", "leave"]);
    expect(useDmCalls.getState().active?.phase).toBe("cancelled");
    expect(useDmCalls.getState().notice).toBeNull();
  });

  it("without Sew's callCancel the server left instead: the line says they'll see a missed call", async () => {
    api.cancelDmCall.mockResolvedValue({ ok: true, cancelled: false, via: "leave", callId: "4455", hint: "no cancel" });
    await startDmCall("s1", "900", { name: "Alex" });
    await cancelOutgoingDmCall();
    expect(useDmCalls.getState().notice?.text).toMatch(/Alex will see a missed call/);
  });

  it("rings again with Sew's id, three times at most", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    for (let i = 0; i < RING_AGAIN_MAX; i++) {
      expect(canRingAgain(useDmCalls.getState().active)).toBe(true);
      await callAgainDmCall();
    }
    expect(api.ringDmCallAgain).toHaveBeenCalledTimes(RING_AGAIN_MAX);
    expect(api.ringDmCallAgain).toHaveBeenLastCalledWith(expect.anything(), "900", "4455");
    expect(canRingAgain(useDmCalls.getState().active)).toBe(false);
    await callAgainDmCall();
    expect(api.ringDmCallAgain).toHaveBeenCalledTimes(RING_AGAIN_MAX);
  });

  it("a decline ends the media and shows 'declined' with Call again for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await startDmCall("s1", "900", { name: "Alex" });
    events!.onState("connected");
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ state: "ended", end_reason: "declined" }) });
    expect(useDmCalls.getState().active?.phase).toBe("declined");
    expect(engine.leave).toHaveBeenCalled();
    expect(canRingAgain(useDmCalls.getState().active)).toBe(true);
    await vi.advanceTimersByTimeAsync(CALL_ENDED_SHOW_MS + 10);
    expect(useDmCalls.getState().active).toBeNull();
  });

  it("an unanswered call reads as missed; an older call's end is ignored", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ id: "1111", state: "ended", end_reason: "no_answer" }) });
    expect(useDmCalls.getState().active?.phase).toBe("ringing");
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ state: "ended", end_reason: "no_answer" }) });
    expect(useDmCalls.getState().active?.phase).toBe("missed");
  });

  it("hanging up a connected call leaves K2's record with K2's vc_ id", async () => {
    await startDmCall("s1", "900", { name: "Alex" });
    events!.onState("connected");
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ state: "active", participant_ids: ["100", "200"] }) });
    await useVoiceCall.getState().leave();
    expect(api.leaveDmCall).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "vc_abc");
    expect(useDmCalls.getState().active).toBeNull();
  });
});

describe("phaseFromCall", () => {
  it("reads the other person's ring for the caller, and 'connected' for the answerer", () => {
    expect(phaseFromCall(call(), "caller")).toBe("ringing");
    expect(phaseFromCall(call({ rings: [{ member_id: "200", state: "declined" }] }), "caller")).toBe("declined");
    expect(phaseFromCall(call(), "answerer")).toBe("connected");
    expect(phaseFromCall(call({ state: "ended", end_reason: "cancelled" }), "caller")).toBe("cancelled");
  });
});

// ─── Rings ───

describe("ring cards", () => {
  it("call_ring puts a card up with the caller's name, and ringing:false takes it down", async () => {
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
    expect(useDmCalls.getState().rings).toHaveLength(1);
    await flush();
    expect(useDmCalls.getState().rings[0]).toMatchObject({ callerName: "Alex Kim", silent: false, busy: null, callId: "4455" });
    for (const reason of ["accepted", "declined", "timeout", "call_ended", "cancelled"]) {
      onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
      onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring({ ringing: false, reason }) });
      expect(useDmCalls.getState().rings).toHaveLength(0);
    }
  });

  it("keeps a silent ring silent, and drops it when it times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring({ silent: true, expires_at: new Date(Date.now() + 1000).toISOString() }) });
    expect(useDmCalls.getState().rings[0].silent).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(useDmCalls.getState().rings).toHaveLength(0);
  });

  it("hello replaces the server's cards with the rings going now", () => {
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring({ call_id: "1" }) });
    onHomeChatCallFrame("s1", { type: "hello", chat: "live", flags: {} as never, rings: [ring({ call_id: "2" })], calls: [] });
    expect(useDmCalls.getState().rings.map((r) => r.callId)).toEqual(["2"]);
  });

  it("an ended call takes its card down", () => {
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
    onHomeChatCallFrame("s1", { type: "call_updated", conv: "900", call: call({ state: "ended", end_reason: "cancelled" }) });
    expect(useDmCalls.getState().rings).toHaveLength(0);
  });

  it("Accept joins {dm} (that join answers the ring)", async () => {
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
    await flush();
    const key = useDmCalls.getState().rings[0].key;
    await acceptRing(key);
    expect(engine.joins).toEqual([["s1", "dm:900"]]);
    expect(useDmCalls.getState().rings).toHaveLength(0);
    expect(useDmCalls.getState().active).toMatchObject({ role: "answerer", phase: "connected", name: "Alex Kim" });
  });

  it("Decline sends decline {dm, callId} with Sew's id", async () => {
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
    await declineRing("s1|4455");
    expect(api.declineDmCall).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "900", "4455");
    expect(useDmCalls.getState().rings).toHaveLength(0);
    expect(engine.join).not.toHaveBeenCalled();
  });

  it("a failed decline keeps the card to try again", async () => {
    api.declineDmCall.mockResolvedValue({ ok: false, kind: "network", code: "network", hint: "", status: null });
    onHomeChatCallFrame("s1", { type: "call_ring", conv: "900", ring: ring() });
    await declineRing("s1|4455");
    expect(useDmCalls.getState().rings[0]).toMatchObject({ busy: null });
    expect(useDmCalls.getState().notice?.text).toMatch(/Couldn't decline/);
  });
});

// ─── Push and the Home row ───

describe("push and rows", () => {
  const known = (id: string) => id === "s1";

  it("a tap opens the DM by conversationId on the push's own server", async () => {
    await routeCallTap({ kind: "call", callId: "4455", conversationId: "900", callState: "missed", k2ServerId: "s1" }, async () => null, known);
    expect(useHomeChatOpenRequest.getState().pending).toMatchObject({ serverId: "s1", conversationId: "900", from: "call-push" });
    expect(engine.join).not.toHaveBeenCalled();
  });

  it("Accept joins {dm}, named by the notification's title", async () => {
    await routeCallTap(
      { kind: "call", callId: "4455", conversationId: "900", callState: "ringing", k2ServerId: "s1", action: "accept", title: "Alex" },
      async () => null,
      known
    );
    expect(engine.joins).toEqual([["s1", "dm:900"]]);
    expect(useVoiceCall.getState().room?.roomName).toBe("Alex");
  });

  it("a decline the native side couldn't send is sent here; an unknown server falls back to the resolver", async () => {
    const resolve = vi.fn(async () => "s1");
    await routeCallTap({ kind: "call", callId: "4455", conversationId: "900", k2ServerId: "gone", action: "decline" }, resolve, known);
    expect(resolve).toHaveBeenCalled();
    expect(api.declineDmCall).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "900", "4455");
  });

  it("a push in the foreground puts a card up, and its replacement takes it down", () => {
    noteCallPush({ kind: "call", callId: "4455", conversationId: "900", callState: "ringing", k2ServerId: "s1", title: "Alex" }, known);
    expect(useDmCalls.getState().rings[0]).toMatchObject({ callerName: "Alex", key: "s1|4455" });
    noteCallPush({ kind: "call", callId: "4455", conversationId: "900", callState: "answered", k2ServerId: "s1" }, known);
    expect(useDmCalls.getState().rings).toHaveLength(0);
  });

  it("a person's row opens the DM first when it doesn't know it", async () => {
    api.openHomeChatDm.mockResolvedValue({ ok: true, conv: "900", created: false });
    await callPersonFromRow("s1", { ext: "k2:connect:a", displayName: "Alex Kim" });
    expect(api.openHomeChatDm).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "k2:connect:a");
    expect(engine.joins).toEqual([["s1", "dm:900"]]);
    expect(useDmCalls.getState().active?.name).toBe("Alex Kim");
  });

  it("a row that can't open its DM says why", async () => {
    api.openHomeChatDm.mockResolvedValue({ ok: false, kind: "plan", code: "host_not_pro", hint: "", status: 403 });
    await callPersonFromRow("s1", { ext: "k2:connect:a", displayName: "Alex Kim" });
    expect(engine.join).not.toHaveBeenCalled();
    expect(useDmCalls.getState().notice?.text).toBe("Calls need the Pro plan on that server.");
  });
});
