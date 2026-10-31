import { beforeEach, describe, expect, it, vi } from "vitest";

// MA21: Zen's server is a fake scope (`zen()`), not mocked globals.
vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

vi.mock("../api/client", () => ({
  getActivitySnapshot: vi.fn(),
}));

import { getActivitySnapshot } from "../api/client";
import { EMPTY_ACTIVITY } from "./agentActivity";
import { useZenStore } from "./zenStore";
import { __resetActivityLiveForTests } from "./activityLive";
import { fakeScope } from "../test/fakeScope";
import { setZenScope, zen } from "../test/zenScopeMock";

// A fresh fake server per test (was: getActiveServer / getToken mocks).
beforeEach(() => {
  setZenScope(fakeScope({ id: "s1" }));
});


const BODY = {
  rows: [{ sessionId: "m", agentName: "p", display: "working", workspacePath: "/w" }],
  workspaces: [{ workspacePath: "/w", display: "working" }],
};

describe("refreshActivity", () => {
  beforeEach(() => {
    vi.mocked(getActivitySnapshot).mockReset();
    zen().setId("s1"); zen().setUsername("");
    useZenStore.setState({ agentSource: "live", activity: EMPTY_ACTIVITY });
  });

  it("does not replace an unchanged snapshot (no re-render)", async () => {
    vi.mocked(getActivitySnapshot).mockResolvedValue({ ok: true, data: BODY });
    await useZenStore.getState().refreshActivity();
    const first = useZenStore.getState().activity;
    expect(first.bySession.m.display).toBe("working");
    await useZenStore.getState().refreshActivity();
    expect(useZenStore.getState().activity).toBe(first);
  });

  it("keeps the last snapshot on a transient error, clears it on 404", async () => {
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: true, data: BODY });
    await useZenStore.getState().refreshActivity();
    const shown = useZenStore.getState().activity;
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: false, error: "HTTP 502", status: 502 });
    await useZenStore.getState().refreshActivity();
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: false, error: "Could not reach server: x" });
    await useZenStore.getState().refreshActivity();
    expect(useZenStore.getState().activity).toBe(shown);
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: false, error: "route not found", status: 404 });
    await useZenStore.getState().refreshActivity();
    expect(useZenStore.getState().activity).toBe(EMPTY_ACTIVITY);
  });

  it("clears another server's dots after a switch", async () => {
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: true, data: BODY });
    await useZenStore.getState().refreshActivity();
    zen().setId("s2"); zen().setUsername("");
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: false, error: "HTTP 502", status: 502 });
    await useZenStore.getState().refreshActivity();
    expect(useZenStore.getState().activity).toBe(EMPTY_ACTIVITY);
  });

  it("allows one request in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(getActivitySnapshot).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)) as never
    );
    const a = useZenStore.getState().refreshActivity();
    const b = useZenStore.getState().refreshActivity();
    expect(getActivitySnapshot).toHaveBeenCalledTimes(1);
    resolve({ ok: true, data: BODY });
    await Promise.all([a, b]);
    expect(useZenStore.getState().activity.bySession.m.display).toBe("working");
  });
});

describe("activity from hub frames (speed PRD A2)", () => {
  const SNAP = { ...BODY, seq: 10, instanceId: "i1" };
  const frame = (seq: number, display: string, extra: Record<string, unknown> = {}) => ({
    kind: "activity_changed",
    seq,
    instanceId: "i1",
    row: { sessionId: "m", agentName: "p", display, workspacePath: "/w" },
    removed: null,
    turnEnded: null,
    workspace: { workspacePath: "/w", display },
    ...extra,
  });
  const flushFrame = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    __resetActivityLiveForTests();
    vi.mocked(getActivitySnapshot).mockReset();
    zen().setId("s1");
    zen().setUsername("");
    useZenStore.setState({ agentSource: "live", activity: EMPTY_ACTIVITY });
    vi.mocked(getActivitySnapshot).mockResolvedValueOnce({ ok: true, data: SNAP as never });
    await useZenStore.getState().refreshActivity();
  });

  it("a frame that follows on updates the dots with no request", async () => {
    useZenStore.getState().applyActivityFrame(frame(11, "idle"));
    await flushFrame();
    expect(useZenStore.getState().activity.bySession.m.display).toBe("idle");
    expect(getActivitySnapshot).toHaveBeenCalledTimes(1);
  });

  it("an old frame is ignored; a gap or a restarted daemon re-reads the snapshot", async () => {
    useZenStore.getState().applyActivityFrame(frame(9, "idle"));
    await flushFrame();
    expect(useZenStore.getState().activity.bySession.m.display).toBe("working");
    vi.mocked(getActivitySnapshot).mockResolvedValue({ ok: true, data: { ...SNAP, seq: 20 } as never });
    useZenStore.getState().applyActivityFrame(frame(13, "idle"));
    await flushFrame();
    expect(getActivitySnapshot).toHaveBeenCalledTimes(2);
    useZenStore.getState().applyActivityFrame(frame(21, "idle", { instanceId: "i2" }));
    await flushFrame();
    // Re-reads are at least 2 s apart.
    expect(getActivitySnapshot).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 2050));
    expect(getActivitySnapshot).toHaveBeenCalledTimes(3);
  });

  it("frames during a snapshot read apply on top of it; older ones are dropped", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(getActivitySnapshot).mockImplementationOnce(() => new Promise((r) => (resolve = r)) as never);
    const p = useZenStore.getState().refreshActivity();
    useZenStore.getState().applyActivityFrame(frame(30, "idle")); // covered by the snapshot
    useZenStore.getState().applyActivityFrame(frame(31, "waiting"));
    resolve({ ok: true, data: { ...SNAP, seq: 30 } as never });
    await p;
    expect(useZenStore.getState().activity.bySession.m.display).toBe("waiting");
  });
});
