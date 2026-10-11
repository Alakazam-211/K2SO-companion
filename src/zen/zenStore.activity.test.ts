import { beforeEach, describe, expect, it, vi } from "vitest";

// MA21: Zen's server is a fake scope (`zen()`), not mocked globals.
vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

vi.mock("../api/client", () => ({
  getActivitySnapshot: vi.fn(),
}));

import { getActivitySnapshot } from "../api/client";
import { EMPTY_ACTIVITY } from "./agentActivity";
import { useZenStore } from "./zenStore";
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
