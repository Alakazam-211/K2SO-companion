import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({
  onFrame: null as ((f: unknown) => void) | null,
  onOpen: null as ((id: string) => void) | null,
  sent: [] as unknown[],
  stopped: 0,
}));
vi.mock("./ticketEvents", () => ({
  subscribeAppEvents: (_s: unknown, _m: unknown, _c: unknown, onFrame: (f: unknown) => void) => {
    hub.onFrame = onFrame;
    return { stop: () => void (hub.stopped += 1) };
  },
  onHubOpen: (fn: (id: string) => void) => {
    hub.onOpen = fn;
    return () => {};
  },
  hubSend: (_id: string, frame: unknown) => {
    hub.sent.push(frame);
    return true;
  },
}));
const overlay = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./overlayEvents", () => ({ connectOverlayEvents: (...a: unknown[]) => overlay.connect(...a) }));

import { __resetHubViewingForTests, connectHubViewing, VIEWING_RESEND_MS } from "./hubViewing";

const scope = { id: "s1" } as never;
const frame = (f: Record<string, unknown>) => hub.onFrame!(f);
const ok = (over: Record<string, unknown> = {}) =>
  frame({ kind: "viewing_ok", conversation_id: "c1", rev: 10, convRev: 7, instanceId: "i1", turn: null, ...over });

function open() {
  const onItem = vi.fn();
  const onNeedCatchUp = vi.fn();
  const onTurn = vi.fn();
  const h = connectHubViewing({ scope, conversationId: "c1", onItem, onNeedCatchUp, onTurn });
  return { h, onItem, onNeedCatchUp, onTurn };
}

beforeEach(() => {
  __resetHubViewingForTests();
  hub.sent = [];
  hub.stopped = 0;
  overlay.connect.mockReset().mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
});
afterEach(() => vi.useRealTimers());

describe("the open Thread on the hub (K2 0.46.8 hub-viewing-v1)", () => {
  it("asks for the view, repeats it inside the 90 s TTL, and lets go on stop", () => {
    vi.useFakeTimers();
    const { h } = open();
    h.setViewing(true);
    expect(hub.sent).toEqual([{ t: "viewing", conversationId: "c1", visible: true }]);
    vi.advanceTimersByTime(VIEWING_RESEND_MS);
    expect(hub.sent).toHaveLength(2);
    // A hub reopen loses the view: asked again.
    hub.onOpen!("s1");
    expect(hub.sent).toHaveLength(3);
    h.stop();
    expect(hub.sent[hub.sent.length - 1]).toEqual({ t: "viewing", conversationId: "c1", visible: false });
    expect(hub.stopped).toBe(1);
  });

  it("viewing_ok seeds the turn; reads only when the chat moved past what we had", () => {
    const { h, onNeedCatchUp, onTurn } = open();
    h.setViewing(true);
    ok({ turn: { turnId: "t1" } });
    expect(onTurn).toHaveBeenCalledWith({ turn: { turnId: "t1" } });
    // The first view rides the open's own read.
    expect(onNeedCatchUp).not.toHaveBeenCalled();
    // Same daemon, nothing new in this chat since rev 10: no read.
    ok({ rev: 14, convRev: 10, reason: "lagged" });
    expect(onNeedCatchUp).not.toHaveBeenCalled();
    // This chat moved past rev 14: read.
    ok({ rev: 20, convRev: 18 });
    expect(onNeedCatchUp).toHaveBeenCalledTimes(1);
    // A restarted daemon: always read.
    ok({ rev: 2, convRev: 1, instanceId: "i2" });
    expect(onNeedCatchUp).toHaveBeenCalledTimes(2);
  });

  it("this chat's messages go in; a cut-short one reads instead; other chats are ignored", () => {
    const { onItem, onNeedCatchUp } = open();
    const msg = { kind: "thread_message", conversation_id: "c1", collection: "thread", seq: 4, id: "m4", rev: 11, doc: { body: "hi" } };
    frame(msg);
    expect(onItem).toHaveBeenCalledWith(msg);
    frame({ ...msg, id: "m5", truncated: true, doc: undefined });
    expect(onNeedCatchUp).toHaveBeenCalledTimes(1);
    frame({ ...msg, conversation_id: "other" });
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("activity frames go to the strip; a reset carries the turn as it is now", () => {
    const { onItem, onTurn } = open();
    const act = { kind: "thread_activity", conversation_id: "c1", collection: "activity", id: "a", activity: {} };
    frame(act);
    expect(onItem).toHaveBeenCalledWith(act);
    frame({ kind: "thread_activity_reset", conversation_id: "c1", turn: { turnId: "t2" } });
    expect(onTurn).toHaveBeenCalledWith({ turn: { turnId: "t2" } });
  });

  it("a move is followed: the new conversation's frames come in", () => {
    const { onItem, onNeedCatchUp } = open();
    frame({ kind: "thread_moved", from: "c1", to: "c2", seq: 1, rev: 12 });
    expect(onNeedCatchUp).toHaveBeenCalledTimes(1);
    frame({ kind: "thread_message", conversation_id: "c2", collection: "thread", id: "x", seq: 2, rev: 13, doc: {} });
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("a refused view falls back to the overlay socket for this chat", () => {
    const { h } = open();
    h.setViewing(true);
    frame({ kind: "viewing_error", conversation_id: "c1", code: "forbidden" });
    expect(overlay.connect).toHaveBeenCalledTimes(1);
    const fb = overlay.connect.mock.results[0].value;
    expect(fb.setViewing).toHaveBeenCalledWith(true);
    h.stop();
    expect(fb.stop).toHaveBeenCalled();
  });
});
