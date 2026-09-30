import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  getToken: vi.fn(),
  getAgentList: vi.fn(),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
}));

import {
  getAgentList,
  getFsReadDir,
  getThread,
  getToken,
} from "../api/client";
import { STUB_AGENTS, STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, err) => {
    resolve = ok;
    reject = err;
  });
  return { promise, resolve, reject };
}

function dir(name: string, path: string) {
  return { ok: true as const, data: [{ name, path, isDirectory: false }] };
}

function reset() {
  useZenStore.setState({
    agentSource: "stub",
    fileSource: "stub",
    agents: STUB_AGENTS,
    files: STUB_FILES,
    agentError: null,
    fileError: null,
    filesGen: 0,
    screen: "list",
    agentId: STUB_AGENTS[0].id,
    filesOpen: true,
    openFileIds: [],
    focusId: null,
    splitId: null,
    splitRatio: 0.5,
  });
}

describe("signed-in hydrate never exposes the stub catalogue", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getAgentList).mockReset();
    vi.mocked(getFsReadDir).mockReset();
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("does not install stub and does not call a grant-scoped list yet", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { enabled: true, live: false, mode: "local", name: "appa", path: "/Users/Baden/Appa" },
          { enabled: true, live: false, mode: "local", name: "Skin Test A", path: "/ws/skin-a" },
        ],
      },
    });
    await useZenStore.getState().hydrateAgents();
    const mid = useZenStore.getState();
    expect(mid.agentSource).toBe("live");
    expect(mid.agents.map((a) => a.name)).toEqual(["appa", "Skin Test A"]);
    expect(mid.agents.every((a) => a.addr == null)).toBe(true);
    expect(mid.screen).toBe("list");
    expect(mid.agentError).toMatch(/No thread addr/);
    expect(mid.agents.some((a) => a.id.startsWith("stub-"))).toBe(false);
    expect(getAgentList).toHaveBeenCalledOnce();
  });

  it("a bare array from the skills enumerator is a shape error, not a rail", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: [{ name: "k2-cli", agentType: "skill" }],
    });
    await useZenStore.getState().hydrateAgents();
    const mid = useZenStore.getState();
    expect(mid.agentSource).toBe("error");
    expect(mid.agents).toEqual([]);
    expect(mid.agentError).toMatch(/unrecognised shape/);
  });

  it("no token is the only path that installs the stub catalogue", async () => {
    vi.mocked(getToken).mockReturnValue("");
    await useZenStore.getState().hydrateAgents();
    expect(useZenStore.getState().agentSource).toBe("stub");
    expect(useZenStore.getState().agents).toEqual(STUB_AGENTS);
  });
});

describe("hydrateFiles generation token", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("");
    vi.mocked(getFsReadDir).mockReset();
  });

  it("in-flight hydrate is loading, not LIVE empty", async () => {
    const pending = deferred<ReturnType<typeof dir>>();
    vi.mocked(getFsReadDir).mockImplementationOnce(() => pending.promise);
    useZenStore.setState({
      agentSource: "live",
      fileSource: "live",
      files: [{ id: "/old/a.txt", name: "a.txt", body: "" }],
    });
    const p = useZenStore.getState().hydrateFiles("/ws-new");
    const mid = useZenStore.getState();
    expect(mid.files).toEqual([]);
    expect(mid.fileSource).toBe("loading");
    pending.resolve(dir("b.txt", "/ws-new/b.txt"));
    await p;
    expect(useZenStore.getState().fileSource).toBe("live");
    expect(useZenStore.getState().files.map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("drops a slower older read-dir so the later agent wins", async () => {
    const first = deferred<ReturnType<typeof dir>>();
    const second = deferred<ReturnType<typeof dir>>();
    vi.mocked(getFsReadDir)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const p1 = useZenStore.getState().hydrateFiles("/ws-a");
    const p2 = useZenStore.getState().hydrateFiles("/ws-b");

    second.resolve(dir("from-b.txt", "/ws-b/from-b.txt"));
    await p2;
    first.resolve(dir("from-a.txt", "/ws-a/from-a.txt"));
    await p1;

    const s = useZenStore.getState();
    expect(s.files.map((f) => f.name)).toEqual(["from-b.txt"]);
    expect(s.fileSource).toBe("live");
    expect(s.filesGen).toBe(2);
  });

  it("also drops an older success that arrives before the newer one resolves", async () => {
    const first = deferred<ReturnType<typeof dir>>();
    const second = deferred<ReturnType<typeof dir>>();
    vi.mocked(getFsReadDir)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const p1 = useZenStore.getState().hydrateFiles("/ws-a");
    const p2 = useZenStore.getState().hydrateFiles("/ws-b");

    first.resolve(dir("from-a.txt", "/ws-a/from-a.txt"));
    await Promise.resolve();
    expect(useZenStore.getState().files).toEqual([]);

    second.resolve(dir("from-b.txt", "/ws-b/from-b.txt"));
    await Promise.all([p1, p2]);
    expect(useZenStore.getState().files.map((f) => f.name)).toEqual(["from-b.txt"]);
  });
});

describe("live failure never shows the stub catalog", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getFsReadDir).mockReset();
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("read-dir fail → empty files + error, not STUB_FILES", async () => {
    useZenStore.setState({ agentSource: "live", agents: [{ id: "alpha", name: "alpha", initial: "A", path: "/ws" }] });
    vi.mocked(getFsReadDir).mockResolvedValue({ ok: false, error: "read-dir failed" });
    await useZenStore.getState().hydrateFiles("/ws");
    const s = useZenStore.getState();
    expect(s.fileSource).toBe("error");
    expect(s.files).toEqual([]);
    expect(s.fileError).toMatch(/read-dir failed/);
    expect(s.files).not.toBe(STUB_FILES);
  });

  it("signed-in list is empty and honest, not STUB_AGENTS", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: false,
      error: "GET /cli/agent/list failed",
    });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("error");
    expect(s.agents).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.fileSource).toBe("error");
    expect(s.agentError).toMatch(/agent\/list/);
    expect(s.agents).not.toBe(STUB_AGENTS);
  });

  it("no token still uses the labelled stub catalog", async () => {
    vi.mocked(getToken).mockReturnValue("");
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("stub");
    expect(s.fileSource).toBe("stub");
    expect(s.agents).toEqual(STUB_AGENTS);
    expect(s.files).toEqual(STUB_FILES);
  });
});

describe("hydrateThread", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getThread).mockReset();
  });

  it("loads Skin-shaped items as live bubbles", async () => {
    useZenStore.setState({ agentSource: "live", agentId: "k2so-Skin-Test-A" });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "m1",
            seq: 1,
            doc: { from: "k2so-Skin-Test-A", body: "hello", created_at: 1759198521 },
          },
        ],
      },
    });
    await useZenStore.getState().hydrateThread("k2so-Skin-Test-A");
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("live");
    expect(s.thread.map((m) => m.text)).toEqual(["hello"]);
    expect(vi.mocked(getThread).mock.calls[0][0]).toBe("k2so-Skin-Test-A");
  });

  it("thread fail is error + empty, never stub copy", async () => {
    useZenStore.setState({ agentSource: "live", agentId: "alpha", thread: [] });
    vi.mocked(getThread).mockResolvedValue({ ok: false, error: "thread failed" });
    await useZenStore.getState().hydrateThread("alpha");
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("error");
    expect(s.thread).toEqual([]);
    expect(s.threadError).toMatch(/thread failed/);
  });
});

describe("hydrateAgents stays off /cli/skin/agents until owner content is counted", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getFsReadDir).mockReset();
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("setAgent threads the handle, never a display name", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "skin-test-a",
          name: "Skin Test A",
          initial: "ST",
          path: "skin-test-a",
          addr: "skin-test-a",
        },
        {
          id: "NoAddr",
          name: "NoAddr",
          initial: "N",
          path: "NoAddr",
          addr: null,
        },
      ],
      agentId: "skin-test-a",
    });
    vi.mocked(getThread).mockClear();
    useZenStore.getState().setAgent("NoAddr");
    expect(vi.mocked(getThread)).not.toHaveBeenCalled();
    expect(useZenStore.getState().threadError).toBe("Not chattable");
    useZenStore.getState().setAgent("skin-test-a");
    expect(vi.mocked(getThread).mock.calls.map((c) => c[0])).toEqual(["skin-test-a"]);
  });

  it("stub setAgent still loads the stub thread", async () => {
    vi.mocked(getToken).mockReturnValue("");
    await useZenStore.getState().hydrateAgents();
    useZenStore.getState().setAgent(STUB_AGENTS[1].id);
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("stub");
    expect(s.threadError).toBeNull();
    expect(s.thread.length).toBeGreaterThan(0);
  });
});
