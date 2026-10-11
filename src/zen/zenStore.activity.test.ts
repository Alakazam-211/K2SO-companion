import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  getActivitySnapshot: vi.fn(),
  getToken: vi.fn(() => "tok"),
}));

vi.mock("../stores/servers", () => ({
  getActiveServer: vi.fn(() => ({ id: "s1" })),
}));

import { getActivitySnapshot } from "../api/client";
import { getActiveServer } from "../stores/servers";
import { EMPTY_ACTIVITY } from "./agentActivity";
import { useZenStore } from "./zenStore";

const BODY = {
  rows: [{ sessionId: "m", agentName: "p", display: "working", workspacePath: "/w" }],
  workspaces: [{ workspacePath: "/w", display: "working" }],
};

describe("refreshActivity", () => {
  beforeEach(() => {
    vi.mocked(getActivitySnapshot).mockReset();
    vi.mocked(getActiveServer).mockReturnValue({ id: "s1" } as never);
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
    vi.mocked(getActiveServer).mockReturnValue({ id: "s2" } as never);
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
