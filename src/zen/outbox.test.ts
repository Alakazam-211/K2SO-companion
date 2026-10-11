import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, postThread: vi.fn(), getThread: vi.fn() };
});

import { getThread, postThread } from "../api/client";
import { hasLanded, threadRoomKey, visibleOutgoing, type OutgoingMessage } from "./outbox";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { flyKeyframes } from "./sendFly";

const msg = (id: string, text: string, mine = true): ThreadMessage => ({
  id,
  seq: 1,
  text,
  from: mine ? "owner" : "appa",
  at: 1,
  mine,
  kind: "text",
  choice: null,
});

const out = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  localId: "local-1",
  roomKey: threadRoomKey("s1", null, "appa"),
  text: "hi",
  files: [],
  paths: [],
  attachWorkspace: null,
  attachDir: null,
  status: "sending",
  error: null,
  at: 1,
  beforeIds: ["old"],
  body: "hi",
  serverId: null,
  ...over,
});

describe("outbox helpers", () => {
  it("room keys tell servers, groups and addrs apart", () => {
    expect(threadRoomKey("s1", null, "appa")).not.toBe(threadRoomKey("s2", null, "appa"));
    expect(threadRoomKey("s1", "pg1", "appa")).toBe(threadRoomKey("s1", "pg1", null));
  });

  it("lands on the server id, or a NEW mine message with the same body", () => {
    expect(hasLanded(out({ serverId: "n1" }), [msg("n1", "other")])).toBe(true);
    expect(hasLanded(out(), [msg("old", "hi")])).toBe(false);
    expect(hasLanded(out(), [msg("n2", "hi", false)])).toBe(false);
    expect(hasLanded(out(), [msg("n2", " hi ")])).toBe(true);
    expect(hasLanded(out({ body: null }), [msg("n2", "hi")])).toBe(false);
  });

  it("shows only this room's bubbles that have not landed", () => {
    const a = out();
    const b = out({ localId: "local-2", roomKey: threadRoomKey("s1", null, "other") });
    expect(visibleOutgoing([a, b], [], a.roomKey)).toEqual([a]);
    expect(visibleOutgoing([a, b], [msg("n2", "hi")], a.roomKey)).toEqual([]);
  });

  it("fly keyframes: uniform, clamped scale; identity at the end", () => {
    const f = flyKeyframes(
      { left: 20, top: 700, width: 300, height: 24 },
      { left: 200, top: 500, width: 80, height: 36 },
      17 / 14
    );
    expect(f[0].transform).toBe("translate(-195px, 190px) scale(1.214)");
    expect(f[1].transform).toBe("translate(0px, 0px) scale(1)");
    expect(flyKeyframes({ left: 0, top: 0, width: 1, height: 1 }, { left: 0, top: 0, width: 1, height: 1 }, 9)[0].transform).toContain("scale(2.000)");
  });
});

describe("sendThread outbox", () => {
  beforeEach(() => {
    setZenScope(fakeScope({ id: "s1", username: "baden" }));
    vi.mocked(postThread).mockReset();
    vi.mocked(getThread).mockReset();
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      thread: [],
      outbox: [],
      sendError: null,
      sending: false,
    });
  });

  it("a plain call shows a pending bubble at once and keeps it failed on error", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(postThread).mockReturnValue(new Promise((ok) => (answer = ok)) as never);
    const p = useZenStore.getState().sendThread("hello");
    expect(useZenStore.getState().outbox.map((o) => [o.text, o.status])).toEqual([
      ["hello", "sending"],
    ]);
    answer({ ok: false, error: "boom" });
    expect(await p).toBe(false);
    const s = useZenStore.getState();
    expect(s.outbox.map((o) => [o.text, o.status, o.error])).toEqual([["hello", "failed", "boom"]]);
    expect(s.sendError).toBe("boom");
    expect(s.sending).toBe(false);
  });

  it("an entry from another room is never posted here", async () => {
    const id = useZenStore.getState().queueOutgoing({ text: "for appa" });
    useZenStore.setState({ threadAddr: "other", threadGen: useZenStore.getState().threadGen + 1 });
    expect(await useZenStore.getState().sendThread("for appa", { localId: id })).toBe(false);
    expect(postThread).not.toHaveBeenCalled();
    expect(useZenStore.getState().outbox[0].status).toBe("failed");
  });

  it("a failure after the echo landed counts as sent", async () => {
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 2 } });
    vi.mocked(getThread).mockImplementation(async () => {
      useZenStore.setState({ thread: [msg("n1", "hello")] });
      return { ok: false, error: "re-read failed" };
    });
    expect(await useZenStore.getState().sendThread("hello")).toBe(true);
    expect(useZenStore.getState().outbox).toEqual([]);
    expect(useZenStore.getState().sendError).toBeNull();
  });
});
