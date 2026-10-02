import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  getToken: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../stores/servers", () => ({
  getActiveServer: vi.fn(() => null),
}));

import {
  getAgentList,
  getAllSessions,
  getCliProjectsList,
  getFsReadDir,
  getFsReadFile,
  getThread,
  getToken,
  postThread,
  answerThread,
  setSessionLabel,
  setTabTitle,
  spawnSidecarSession,
} from "../api/client";
import { SIDECAR_STORAGE_KEY } from "./sidecarRows";
import {
  fetchProjectGroupMessages,
  fetchProjectGroups,
  postProjectGroupMessage,
} from "../api/projectGroups";
import { getActiveServer } from "../stores/servers";
import { JOIN_NO_AGENT, JOIN_NO_PROJECT } from "./agentRow";
import { resetLastAtQueue } from "./lastAtFetch";
import { STUB_AGENTS, STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";
import { NO_WORKSPACE_PATH, PATH_NOT_OWNED, ROOT_LISTING_HIDDEN } from "./workspacePath";

function liveAt(path: string, id = "ag") {
  return {
    agentSource: "live" as const,
    agentId: id,
    agents: [
      { id, name: id, initial: "A", path, addr: null as string | null },
    ],
  };
}

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
    lastAtByKey: {},
    pinnedIds: [],
    threadConversationId: null,
    threadAddr: null,
    threadGroupId: null,
    thread: [],
  });
}

describe("signed-in hydrate never exposes the stub catalogue", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getAgentList).mockReset();
    vi.mocked(getCliProjectsList).mockReset();
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(getAllSessions).mockReset();
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(spawnSidecarSession).mockReset();
    vi.mocked(fetchProjectGroups).mockReset();
    vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(fetchProjectGroupMessages).mockReset();
    vi.mocked(fetchProjectGroupMessages).mockResolvedValue({
      ok: true,
      data: { messages: [], truncated: false },
    });
    vi.mocked(postProjectGroupMessage).mockReset();
    vi.mocked(getFsReadDir).mockReset();
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("does not install stub; joins handle from /cli/projects/list on path", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { enabled: true, live: false, mode: "local", name: "appa", path: "/Users/Baden/Appa" },
          { enabled: true, live: false, mode: "local", name: "Skin Test A", path: "/ws/skin-a" },
          { enabled: true, live: false, mode: "local", name: "K2 Companion QA", path: "/qa" },
          { enabled: true, live: false, mode: "local", name: "Skydio", path: "/skydio" },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [
        { name: "appa", handle: "appa", path: "/Users/Baden/Appa" },
        { name: "Skin Test A", handle: "skin-test-a", path: "/ws/skin-a" },
        { name: "K2 Companion QA", handle: "k2so-companion-qa", path: "/qa" },
        { name: "Skydio", handle: "manager-2", path: "/skydio" },
      ],
    });
    await useZenStore.getState().hydrateAgents();
    const mid = useZenStore.getState();
    expect(mid.agentSource).toBe("live");
    expect(mid.agents.map((a) => [a.name, a.addr, a.joinMiss])).toEqual([
      ["appa", "appa", null],
      ["Skin Test A", "skin-test-a", null],
      ["K2 Companion QA", "k2so-companion-qa", null],
      ["Skydio", "manager-2", null],
    ]);
    expect(mid.screen).toBe("list");
    expect(mid.agentError).toBeNull();
    expect(mid.agents.some((a) => a.id.startsWith("stub-"))).toBe(false);
    expect(getAgentList).toHaveBeenCalledOnce();
    expect(getCliProjectsList).toHaveBeenCalledOnce();
    expect(getThread).not.toHaveBeenCalled();
    expect(mid.agents[0]).toMatchObject({
      name: "appa",
      mode: "local",
      enabled: true,
      live: false,
    });
  });

  it("hydrateAgents with resumeId keeps the thread instead of flashing the list", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { enabled: true, live: false, mode: "local", name: "appa", path: "/Users/Baden/Appa" },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/Users/Baden/Appa" }],
    });
    await useZenStore.getState().hydrateAgents({
      resumeId: "/Users/Baden/Appa",
    });
    const s = useZenStore.getState();
    expect(s.screen).toBe("thread");
    expect(s.agentId).toBe("/Users/Baden/Appa");
    expect(s.agentSource).toBe("live");
    expect(getThread).toHaveBeenCalled();
  });

  it("ensureLastAt GETs thread limit=1 once and stores created_at", async () => {
    resetLastAtQueue();
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            seq: 22,
            doc: { seq: 22, from: "baden", body: "hi", created_at: 1700000000 },
          },
        ],
      },
    });
    useZenStore.getState().ensureLastAt("t:appa");
    useZenStore.getState().ensureLastAt("t:appa");
    await vi.waitFor(() => {
      expect(useZenStore.getState().lastAtByKey["t:appa"]).toBe(1700000000);
    });
    expect(getThread).toHaveBeenCalledTimes(1);
    expect(getThread).toHaveBeenCalledWith("appa", 1);
  });

  it("a skills enumerator plus a non-array projects body is a shape error, not a rail", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: [{ name: "k2-cli", agentType: "skill" }],
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: { ok: true, agents: [] },
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

describe("files never list the filesystem root", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getFsReadDir).mockReset();
  });

  it("does not request read-dir for /, ~, or a handle", async () => {
    useZenStore.setState(liveAt("/"));
    await useZenStore.getState().hydrateFiles("/");
    useZenStore.setState(liveAt("~"));
    await useZenStore.getState().hydrateFiles("~");
    useZenStore.setState(liveAt("~/Appa"));
    await useZenStore.getState().hydrateFiles("~/Appa");
    useZenStore.setState(liveAt("appa"));
    await useZenStore.getState().hydrateFiles("appa");
    expect(getFsReadDir).not.toHaveBeenCalled();
    expect(useZenStore.getState().fileSource).toBe("error");
    expect(useZenStore.getState().files).toEqual([]);
    expect(useZenStore.getState().fileError).toBe(NO_WORKSPACE_PATH);
  });

  it("refuses a path that is not this agent's own row path", async () => {
    useZenStore.setState(liveAt("/Users/Baden/Appa", "appa"));
    await useZenStore.getState().hydrateFiles("/Users/Baden");
    expect(getFsReadDir).not.toHaveBeenCalled();
    expect(useZenStore.getState().files).toEqual([]);
    expect(useZenStore.getState().fileError).toBe(PATH_NOT_OWNED);
  });

  it("setAgent with / does not call read-dir", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        { id: "appa", name: "appa", initial: "A", path: "/", addr: null },
      ],
    });
    useZenStore.getState().setAgent("appa");
    expect(getFsReadDir).not.toHaveBeenCalled();
    expect(useZenStore.getState().files).toEqual([]);
    expect(useZenStore.getState().fileError).toBe(NO_WORKSPACE_PATH);
  });

  it("sends this agent's own absolute path, not path=.", async () => {
    useZenStore.setState(liveAt("/Users/Baden/Appa", "appa"));
    vi.mocked(getFsReadDir).mockResolvedValue({
      ok: true,
      data: [
        {
          name: "AGENTS.md",
          path: "/Users/Baden/Appa/AGENTS.md",
          isDirectory: false,
        },
      ],
    });
    await useZenStore.getState().hydrateFiles("/Users/Baden/Appa");
    expect(getFsReadDir).toHaveBeenCalledWith("/Users/Baden/Appa");
    expect(useZenStore.getState().fileSource).toBe("live");
    expect(useZenStore.getState().files.map((f) => f.name)).toEqual(["AGENTS.md"]);
  });

  it("hides a root listing even if the request returned 200", async () => {
    useZenStore.setState(liveAt("/Users/Baden/Appa", "appa"));
    vi.mocked(getFsReadDir).mockResolvedValue({
      ok: true,
      data: [
        { name: "etc", path: "/etc", isDirectory: false },
        { name: "home", path: "/home", isDirectory: false },
        { name: "tmp", path: "/tmp", isDirectory: false },
        { name: "var", path: "/var", isDirectory: false },
      ],
    });
    await useZenStore.getState().hydrateFiles("/Users/Baden/Appa");
    expect(useZenStore.getState().fileSource).toBe("error");
    expect(useZenStore.getState().files).toEqual([]);
    expect(useZenStore.getState().fileError).toBe(ROOT_LISTING_HIDDEN);
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
      ...liveAt("/ws-new"),
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

    useZenStore.setState({
      agentSource: "live",
      agentId: "a",
      agents: [
        { id: "a", name: "a", initial: "A", path: "/ws-a", addr: null },
        { id: "b", name: "b", initial: "B", path: "/ws-b", addr: null },
      ],
    });
    const p1 = useZenStore.getState().hydrateFiles("/ws-a");
    useZenStore.setState({ agentId: "b" });
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

    useZenStore.setState({
      agentSource: "live",
      agentId: "a",
      agents: [
        { id: "a", name: "a", initial: "A", path: "/ws-a", addr: null },
        { id: "b", name: "b", initial: "B", path: "/ws-b", addr: null },
      ],
    });
    const p1 = useZenStore.getState().hydrateFiles("/ws-a");
    useZenStore.setState({ agentId: "b" });
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
    vi.mocked(getAllSessions).mockReset();
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
  });

  it("read-dir fail → empty files + error, not STUB_FILES", async () => {
    useZenStore.setState({
      ...liveAt("/ws", "alpha"),
      agents: [{ id: "alpha", name: "alpha", initial: "A", path: "/ws" }],
    });
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
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: false,
      error: "GET /cli/projects/list failed",
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

  it("agent-only path stays on the list as not chattable", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [{ name: "appa", path: "/Users/Baden/Appa" }],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("live");
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0].name).toBe("appa");
    expect(s.agents[0].addr).toBeNull();
    expect(s.agents[0].joinMiss).toBe(JOIN_NO_PROJECT);
  });

  it("project-only path stays on the list as not chattable and does not use its handle", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: { ok: true, agents: [] },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [
        { name: "Skin Test A", handle: "skin-test-a", path: "/ws/skin-a" },
      ],
    });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("live");
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0].name).toBe("Skin Test A");
    expect(s.agents[0].addr).toBeNull();
    expect(s.agents[0].joinMiss).toBe(JOIN_NO_AGENT);
  });

  it("matching names with different paths do not transfer a handle", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [{ name: "Skydio", path: "/Users/Baden/AI Projects/Skydio" }],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "Skydio", handle: "manager-2", path: "/not/skydio" }],
    });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agents).toHaveLength(2);
    expect(s.agents.every((a) => a.addr == null)).toBe(true);
    expect(s.agents.map((a) => a.joinMiss)).toEqual([JOIN_NO_PROJECT, JOIN_NO_AGENT]);
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
        conversation_id: "conv-skin-a",
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
    expect(s.threadConversationId).toBe("conv-skin-a");
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

  it("ingestThreadRaw appends an unseen socket item", async () => {
    useZenStore.setState({ agentSource: "live", agentId: "appa" });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        conversation_id: "conv-a",
        items: [
          { id: "a", seq: 1, doc: { from: "appa", body: "old", created_at: 1 } },
        ],
      },
    });
    await useZenStore.getState().hydrateThread("appa");
    useZenStore.getState().ingestThreadRaw({
      id: "b",
      seq: 2,
      doc: { from: "appa", body: "live", created_at: 2 },
    });
    expect(useZenStore.getState().thread.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("refreshOpenThread merges without wiping the open thread", async () => {
    useZenStore.setState({ agentSource: "live", agentId: "appa" });
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        conversation_id: "conv-a",
        items: [
          { id: "a", seq: 1, doc: { from: "appa", body: "old", created_at: 1 } },
        ],
      },
    });
    await useZenStore.getState().hydrateThread("appa");
    const shown = useZenStore.getState().thread;
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        conversation_id: "conv-a",
        items: [
          { id: "a", seq: 1, doc: { from: "appa", body: "old", created_at: 1 } },
          { id: "b", seq: 2, doc: { from: "appa", body: "new", created_at: 2 } },
        ],
      },
    });
    await useZenStore.getState().refreshOpenThread();
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("live");
    expect(s.thread.map((m) => m.id)).toEqual(["a", "b"]);
    expect(s.thread[0]).toBe(shown[0]);
    expect(s.threadConversationId).toBe("conv-a");
  });

  it("refreshOpenThread keeps the thread when GET fails", async () => {
    useZenStore.setState({ agentSource: "live", agentId: "appa" });
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        conversation_id: "conv-a",
        items: [
          { id: "a", seq: 1, doc: { from: "appa", body: "old", created_at: 1 } },
        ],
      },
    });
    await useZenStore.getState().hydrateThread("appa");
    vi.mocked(getThread).mockResolvedValueOnce({ ok: false, error: "down" });
    await useZenStore.getState().refreshOpenThread();
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("live");
    expect(s.thread.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("hydrateAgents stays off /cli/skin/agents until owner content is counted", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getFsReadDir).mockReset();
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
    vi.mocked(postThread).mockReset();
    vi.mocked(getActiveServer).mockReset();
    vi.mocked(getActiveServer).mockReturnValue(null);
    vi.mocked(getAllSessions).mockReset();
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(spawnSidecarSession).mockReset();
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

  it("a failed send leaves the thread unchanged and shows the wire reason", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "skin-test-a",
      thread: [
        {
          id: "old",
          seq: 1,
          text: "already here",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
      sendError: null,
      sending: false,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: false,
      error: "unknown overlay addr 'nope'",
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.thread.map((m) => m.id)).toEqual(["old"]);
    expect(s.sendError).toMatch(/unknown overlay addr/);
    expect(s.sending).toBe(false);
    expect(getThread).not.toHaveBeenCalled();
  });

  it("POSTs to a live room that is not a named test addr", async () => {
    vi.mocked(getActiveServer).mockReturnValue({
      id: "s",
      nickname: "x",
      url: "https://baden.k2.dev",
      username: "baden",
      rememberPassword: false,
    });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      thread: [],
      sendError: null,
      sending: false,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "n1", seq: 40, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "n1",
            seq: 40,
            doc: { id: "n1", from: "baden", body: "hello", created_at: 3 },
          },
        ],
      },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(postThread).toHaveBeenCalledWith("appa", "hello");
    expect(s.sendError).toBeNull();
    expect(s.thread.map((m) => m.id)).toEqual(["n1"]);
    expect(s.sending).toBe(false);
  });

  it("does not fall back when via=compose is refused", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "k2so-companion-qa",
      thread: [],
      sendError: null,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: false,
      error: "skin tokens cannot use via=compose",
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.thread).toEqual([]);
    expect(s.sendError).toBe("skin tokens cannot use via=compose");
    expect(s.sending).toBe(false);
    expect(getThread).not.toHaveBeenCalled();
    expect(postThread).toHaveBeenCalledTimes(1);
  });

  it("does not treat a POST ack as delivered until GET shows the id", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "skin-test-a",
      thread: [],
      sendError: null,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "ghost", seq: 9, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [] },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.thread).toEqual([]);
    expect(s.sendError).toBe("sent but not on the wire");
  });

  it("does not treat a POST ack as delivered when GET shows the id as the agent", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "skin-test-a",
      thread: [
        {
          id: "old",
          seq: 1,
          text: "already here",
          from: "owner",
          at: 1,
          mine: true,
          kind: "text",
          choice: null,
        },
      ],
      sendError: null,
      sending: false,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "66fa", seq: 20, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "old",
            seq: 1,
            doc: { id: "old", from: "owner", body: "already here", created_at: 1 },
          },
          {
            id: "66fa",
            seq: 20,
            doc: {
              id: "66fa",
              from: "k2so-companion-qa",
              body: "hello",
              created_at: 2,
            },
          },
        ],
      },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.thread.map((m) => m.id)).toEqual(["old"]);
    expect(s.sendError).toBe(
      "sent but the speaker was wrong (from='k2so-companion-qa')"
    );
    expect(s.sending).toBe(false);
  });

  it("rejects the room agent even when the signed-in username is that handle", async () => {
    vi.mocked(getActiveServer).mockReturnValue({
      id: "s",
      nickname: "x",
      url: "https://baden.k2.dev",
      username: "k2so-companion-qa",
      rememberPassword: false,
    });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "k2so-companion-qa",
      thread: [],
      sendError: null,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "66fa", seq: 20, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "66fa",
            seq: 20,
            doc: {
              id: "66fa",
              from: "k2so-companion-qa",
              body: "hello",
              created_at: 2,
            },
          },
        ],
      },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.thread).toEqual([]);
    expect(s.sendError).toBe(
      "sent but the speaker was wrong (from='k2so-companion-qa')"
    );
  });

  it("accepts from= the signed-in username as owner authorship", async () => {
    vi.mocked(getActiveServer).mockReturnValue({
      id: "s",
      nickname: "x",
      url: "https://baden.k2.dev",
      username: "baden",
      rememberPassword: false,
    });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "k2so-companion-qa",
      thread: [],
      sendError: null,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "ok1", seq: 21, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "ok1",
            seq: 21,
            doc: { id: "ok1", from: "baden", body: "hello", created_at: 1 },
          },
        ],
      },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.sendError).toBeNull();
    expect(s.thread.map((m) => [m.id, m.from, m.mine])).toEqual([
      ["ok1", "baden", true],
    ]);
  });

  it("appends a send only after GET returns the posted id", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "skin-test-a",
      thread: [],
      sendError: null,
    });
    vi.mocked(postThread).mockResolvedValue({
      ok: true,
      data: { id: "ed60", seq: 31, body: "hello" },
    });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "ed60",
            seq: 31,
            doc: { id: "ed60", from: "owner", body: "hello", created_at: 1 },
          },
        ],
      },
    });
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(s.sendError).toBeNull();
    expect(s.thread.map((m) => [m.id, m.text, m.mine])).toEqual([
      ["ed60", "hello", true],
    ]);
  });

  it("empty text and stub do not POST", async () => {
    useZenStore.setState({
      agentSource: "stub",
      threadSource: "stub",
      threadAddr: "stub-1",
    });
    await useZenStore.getState().sendThread("   ");
    await useZenStore.getState().sendThread("hello");
    expect(postThread).not.toHaveBeenCalled();
  });

  it("loadEarlier prepends older items and keeps the ones already shown", async () => {
    useZenStore.setState({ agentSource: "live" });
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        has_more: true,
        items: [
          { id: "n", seq: 10, doc: { from: "appa", body: "new", created_at: 2 } },
        ],
      },
    });
    await useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadHasMore).toBe(true);
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        has_more: false,
        items: [
          { id: "o", seq: 1, doc: { from: "appa", body: "old", created_at: 1 } },
        ],
      },
    });
    await useZenStore.getState().loadEarlier();
    expect(useZenStore.getState().thread.map((m) => m.id)).toEqual(["o", "n"]);
    expect(vi.mocked(getThread).mock.calls[1][2]).toBe(10);
    expect(useZenStore.getState().threadHasMore).toBe(false);
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

const GROUP_ROW = {
  id: "pg1",
  name: "K2 Companion",
  pocWorkspaceId: null,
  pinned: false,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  memberCount: 3,
};

describe("OPEN 8 project groups in hydrateAgents", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getAgentList).mockReset();
    vi.mocked(getCliProjectsList).mockReset();
    vi.mocked(getAllSessions).mockReset();
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(spawnSidecarSession).mockReset();
    vi.mocked(fetchProjectGroups).mockReset();
    vi.mocked(fetchProjectGroupMessages).mockReset();
    vi.mocked(postProjectGroupMessage).mockReset();
    vi.mocked(postThread).mockReset();
    vi.mocked(getActiveServer).mockReturnValue(null);
  });

  it("prepends project groups ahead of agent rows", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [{ name: "appa", path: "/ws", enabled: true, live: true, mode: "custom" }],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/ws" }],
    });
    vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [GROUP_ROW] });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("live");
    expect(s.agents.map((a) => [a.id, a.kind, a.name])).toEqual([
      ["group:pg1", "group", "K2 Companion"],
      ["/ws", "agent", "appa"],
    ]);
    expect(s.agents[0].groupId).toBe("pg1");
    expect(s.agents[0].memberCount).toBe(3);
    expect(s.agents[0].addr).toBeNull();
  });

  it("a group-only list is live, not an empty error", async () => {
    vi.mocked(getAgentList).mockResolvedValue({ ok: true, data: { ok: true, agents: [] } });
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [GROUP_ROW] });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("live");
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0].kind).toBe("group");
    expect(s.agentError).toBeNull();
  });

  it("opening a project chat hydrates messages, refuses files, and sends via project-group/msg", async () => {
    vi.mocked(getActiveServer).mockReturnValue({
      id: "s1",
      nickname: "test",
      url: "https://example.k2.dev",
      username: "baden",
      rememberPassword: false,
    });
    vi.mocked(fetchProjectGroupMessages).mockResolvedValue({
      ok: true,
      data: {
        messages: [
          { id: "m1", groupId: "pg1", author: "owner", body: "hello", createdAt: 10 },
        ],
        truncated: false,
      },
    });
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "group:pg1",
          name: "K2 Companion",
          initial: "K",
          kind: "group",
          groupId: "pg1",
          memberCount: 3,
          addr: null,
          joinMiss: null,
        },
      ],
      threadAddr: "leftover",
      sendError: null,
    });
    useZenStore.getState().setAgent("group:pg1");
    expect(useZenStore.getState().fileError).toMatch(/per workspace/);
    expect(useZenStore.getState().files).toEqual([]);
    await vi.waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(fetchProjectGroupMessages).toHaveBeenCalledWith("pg1", { limit: 50 });
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello"]);
    expect(useZenStore.getState().thread[0].mine).toBe(true);
    expect(useZenStore.getState().threadAddr).toBeNull();
    expect(useZenStore.getState().threadGroupId).toBe("pg1");
    vi.mocked(postProjectGroupMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "m2",
        groupId: "pg1",
        author: "baden",
        body: "nope",
        createdAt: 11,
        delivered: true,
        deliveryReason: null,
        deliveredSessionId: null,
      },
    });
    await useZenStore.getState().sendThread("nope");
    expect(postThread).not.toHaveBeenCalled();
    expect(postProjectGroupMessage).toHaveBeenCalledWith("pg1", "nope");
    expect(useZenStore.getState().sendError).toBeNull();
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello", "nope"]);
  });

  it("Chat return resume clears leftover thread to loading before fetch", async () => {
    const d = deferred<{ ok: true; data: { ok: true; agents: unknown[] } }>();
    vi.mocked(getAgentList).mockReturnValue(d.promise as never);
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [] });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      thread: [
        {
          id: "stale",
          seq: 1,
          text: "STALE",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    const p = useZenStore.getState().hydrateAgents({ resumeId: "/ws" });
    expect(useZenStore.getState().threadSource).toBe("loading");
    expect(useZenStore.getState().thread).toEqual([]);
    d.resolve({ ok: true, data: { ok: true, agents: [] } });
    await p;
  });
});

describe("answerChoice", () => {
  it("POSTs the option text and marks the card answered", async () => {
    vi.mocked(answerThread).mockResolvedValue({ ok: true, data: {} });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      answeringId: null,
      answerError: null,
      thread: [
        {
          id: "card-1",
          seq: 9,
          text: "",
          from: "appa",
          at: 1,
          mine: false,
          kind: "choice",
          choice: { prompt: "Approve?", options: ["Yes", "No"], answer: null },
        },
      ],
    });
    await useZenStore.getState().answerChoice("card-1", "Yes");
    expect(answerThread).toHaveBeenCalledWith("appa", "card-1", "Yes");
    const s = useZenStore.getState();
    expect(s.thread[0]?.choice?.answer).toBe("Yes");
    expect(s.answeringId).toBeNull();
    expect(s.answerError).toBeNull();
  });

  it("does not POST when the card is already answered", async () => {
    vi.mocked(answerThread).mockClear();
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      thread: [
        {
          id: "card-1",
          seq: 9,
          text: "",
          from: "appa",
          at: 1,
          mine: false,
          kind: "choice",
          choice: { prompt: "Approve?", options: ["Yes", "No"], answer: "Yes" },
        },
      ],
    });
    await useZenStore.getState().answerChoice("card-1", "No");
    expect(answerThread).not.toHaveBeenCalled();
  });
});

describe("sidecar rows come from the session list, not invented / 1", () => {
  const mem = new Map<string, string>();
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    reset();
    mem.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
    });
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getAgentList).mockReset();
    vi.mocked(getCliProjectsList).mockReset();
    vi.mocked(getAllSessions).mockReset();
    vi.mocked(setTabTitle).mockReset();
    vi.mocked(setSessionLabel).mockReset();
    vi.mocked(spawnSidecarSession).mockReset();
    vi.mocked(fetchProjectGroups).mockReset();
    vi.mocked(fetchProjectGroups).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(getThread).mockReset();
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("appa/1 from the server survives hydrate with the workspace name and the session title", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { name: "appa", path: "/Users/Baden/Appa", enabled: true, live: true, mode: "custom" },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/Users/Baden/Appa" }],
    });
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          cwd: "/Users/Baden/Appa",
          workspaceName: "appa",
          agentName: "appa",
          label: "main chat tab",
          isMainChat: true,
        },
        {
          cwd: "/Users/Baden/Appa",
          workspaceName: "appa",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
      ] as never,
    });
    await useZenStore.getState().hydrateAgents();
    const s = useZenStore.getState();
    expect(s.agentSource).toBe("live");
    const side = s.agents.find((a) => a.addr === "appa/1");
    expect(side).toMatchObject({
      name: "appa",
      addr: "appa/1",
      chatTitle: "1",
      path: "/Users/Baden/Appa",
    });
    expect(side?.name).not.toBe("appa / 1");
    expect(s.agents.some((a) => a.addr === "appa")).toBe(true);
  });

  it("hydrate stamps the live sidecar label over a join-derived suffix title", async () => {
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          {
            name: "Skin Test A",
            path: "/Users/Baden/AI Projects/Skin Test A",
            enabled: true,
            live: true,
            mode: "custom",
          },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [
        {
          name: "Skin Test A",
          handle: "skin-test-a",
          path: "/Users/Baden/AI Projects/Skin Test A",
        },
        {
          name: "qa088",
          handle: "skin-test-a/qa088",
          path: "/Users/Baden/AI Projects/Skin Test A",
        },
      ],
    });
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          cwd: "/Users/Baden/AI Projects/Skin Test A",
          workspaceName: "Skin Test A",
          agentName: "qa088",
          label: "Example Sidecar",
          isMainChat: false,
          tabId: "tab-example",
          projectId: "proj-skin",
        },
      ] as never,
    });
    await useZenStore.getState().hydrateAgents();
    const extra = useZenStore.getState().agents.find((a) => a.addr === "skin-test-a/qa088");
    expect(extra).toMatchObject({
      name: "Skin Test A",
      chatTitle: "Example Sidecar",
      tabId: "tab-example",
      projectId: "proj-skin",
    });
  });

  it("renameSidecarTitle writes the PTY label and only keeps it when GET sessions agrees", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws::skin-test-a/qa088",
          name: "Skin Test A",
          initial: "ST",
          path: "/ws",
          addr: "skin-test-a/qa088",
          chatTitle: "qa088",
          joinMiss: null,
          kind: "agent",
          tabId: "tab-qa088",
          projectId: "proj-skin",
          terminalId: "tid-qa088",
        },
      ],
    });
    const before = {
      cwd: "/ws",
      workspaceName: "Skin Test A",
      workspaceId: "skin-test-a",
      workspaceColor: "#000",
      agentName: "qa088",
      terminalId: "tid-qa088",
      label: "qa088",
      isMainChat: false,
      tabId: "tab-qa088",
      projectId: "proj-skin",
    };
    vi.mocked(getAllSessions)
      .mockResolvedValueOnce({ ok: true, data: [before] })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ ...before, label: "Example Sidecar" }],
      });
    vi.mocked(setSessionLabel).mockResolvedValue({ ok: true, data: { success: true } });
    vi.mocked(setTabTitle).mockResolvedValue({ ok: true, data: { success: true } });
    const r = await useZenStore
      .getState()
      .renameSidecarTitle("/ws::skin-test-a/qa088", "Example Sidecar");
    expect(r).toEqual({ ok: true });
    expect(setSessionLabel).toHaveBeenCalledWith("tid-qa088", "Example Sidecar");
    expect(setTabTitle).toHaveBeenCalledWith("proj-skin", "tab-qa088", "Example Sidecar");
    expect(useZenStore.getState().agents[0]?.chatTitle).toBe("Example Sidecar");
  });

  it("renameSidecarTitle leaves the old title when GET sessions still returns it", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws::skin-test-a/qa088",
          name: "Skin Test A",
          initial: "ST",
          path: "/ws",
          addr: "skin-test-a/qa088",
          chatTitle: "qa088",
          joinMiss: null,
          kind: "agent",
          terminalId: "tid-qa088",
        },
      ],
    });
    const sess = {
      cwd: "/ws",
      workspaceName: "Skin Test A",
      workspaceId: "skin-test-a",
      workspaceColor: "#000",
      agentName: "qa088",
      terminalId: "tid-qa088",
      label: "qa088",
      isMainChat: false,
    };
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [sess] });
    vi.mocked(setSessionLabel).mockResolvedValue({ ok: true, data: { success: true } });
    const r = await useZenStore
      .getState()
      .renameSidecarTitle("/ws::skin-test-a/qa088", "qa118");
    expect(r).toEqual({ ok: false, error: "K2 did not take the new name" });
    expect(useZenStore.getState().agents[0]?.chatTitle).toBe("qa088");
  });

  it("openSidecar spawns the next unused suffix and does not invent name / 1", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
        },
        {
          id: "/ws::appa/1",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa/1",
          chatTitle: "1",
          joinMiss: null,
          kind: "agent",
        },
      ],
    });
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: true,
      data: { sessionId: "sid-2", agentName: "2" },
    });
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [{ name: "appa", path: "/ws", enabled: true, live: true, mode: "custom" }],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/ws" }],
    });
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        { cwd: "/ws", agentName: "1", label: "1", isMainChat: false },
        { cwd: "/ws", agentName: "2", label: "2", isMainChat: false },
      ] as never,
    });
    const result = await useZenStore.getState().openSidecar("/ws");
    expect(result.ok).toBe(true);
    expect(spawnSidecarSession).toHaveBeenCalledWith("/ws", "2", "2");
    const s = useZenStore.getState();
    const side = s.agents.find((a) => a.addr === "appa/2");
    expect(side).toMatchObject({ name: "appa", addr: "appa/2", chatTitle: "2" });
    expect(s.agents.some((a) => a.name === "appa / 1" || a.name === "appa / 2")).toBe(false);
    expect(s.agentId).toBe(`${"/ws"}::appa/2`);
    expect(s.screen).toBe("thread");
  });

  it("openSidecar does not invent a row when spawn fails", async () => {
    useZenStore.setState({
      agentSource: "live",
      agents: [
        {
          id: "/ws",
          name: "appa",
          initial: "A",
          path: "/ws",
          addr: "appa",
          joinMiss: null,
          kind: "agent",
        },
      ],
    });
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: false,
      error: "unknown overlay addr 'appa/1'",
    });
    const result = await useZenStore.getState().openSidecar("/ws");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown overlay addr|Could not start/i);
    expect(useZenStore.getState().agents.some((a) => a.addr === "appa/1")).toBe(false);
  });

  it("a remembered sidecar stays on the list after the Mac tab closes", async () => {
    localStorage.setItem(
      SIDECAR_STORAGE_KEY,
      JSON.stringify([
        {
          addr: "appa/1",
          path: "/Users/Baden/Appa",
          name: "appa",
          chatTitle: "1",
        },
      ])
    );
    vi.mocked(getAgentList).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        agents: [
          { name: "appa", path: "/Users/Baden/Appa", enabled: true, live: true, mode: "custom" },
        ],
      },
    });
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [{ name: "appa", handle: "appa", path: "/Users/Baden/Appa" }],
    });
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
    await useZenStore.getState().hydrateAgents();
    const side = useZenStore.getState().agents.find((a) => a.addr === "appa/1");
    expect(side).toMatchObject({
      name: "appa",
      addr: "appa/1",
      chatTitle: "1",
      path: "/Users/Baden/Appa",
    });
  });

  it("ensureSidecarHost respawns the PTY when the Mac tab is gone", async () => {
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: true,
      data: { sessionId: "sid-1", agentName: "1" },
    });
    const result = await useZenStore.getState().ensureSidecarHost({
      path: "/Users/Baden/Appa",
      addr: "appa/1",
      chatTitle: "1",
    });
    expect(spawnSidecarSession).toHaveBeenCalledWith(
      "/Users/Baden/Appa",
      "1",
      "1"
    );
    expect(result.ok).toBe(true);
    expect(result.terminalId).toBe("sid-1");
  });

  it("ensureSidecarHost respawns when only the workspace main chat is live", async () => {
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          cwd: "/Users/Baden/AI Projects/Skin Test A",
          workspaceName: "Skin Test A",
          workspaceId: "skin-test-a",
          workspaceColor: "#000",
          agentName: "6fe8c8c6-a207-4612-930c-efa5c8051931",
          terminalId: "main-tid",
          label: "main chat",
          isMainChat: true,
        },
      ],
    });
    vi.mocked(spawnSidecarSession).mockResolvedValue({
      ok: true,
      data: { sessionId: "qa088-tid", agentName: "qa088" },
    });
    const result = await useZenStore.getState().ensureSidecarHost({
      path: "/Users/Baden/AI Projects/Skin Test A",
      addr: "skin-test-a/qa088",
      chatTitle: "qa088",
    });
    expect(spawnSidecarSession).toHaveBeenCalledWith(
      "/Users/Baden/AI Projects/Skin Test A",
      "qa088",
      "qa088"
    );
    expect(result).toEqual({ ok: true, terminalId: "qa088-tid" });
  });

  it("ensureSidecarHost does not spawn when the host session is already live", async () => {
    vi.mocked(getAllSessions).mockResolvedValue({
      ok: true,
      data: [
        {
          cwd: "/Users/Baden/Appa",
          workspaceName: "appa",
          workspaceId: "appa",
          workspaceColor: "#000",
          agentName: "1",
          terminalId: "term-1",
          label: "1",
          isMainChat: false,
        },
      ],
    });
    const result = await useZenStore.getState().ensureSidecarHost({
      path: "/Users/Baden/Appa",
      addr: "appa/1",
      chatTitle: "1",
    });
    expect(spawnSidecarSession).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, terminalId: "term-1" });
  });
});

describe("openFileFromPath", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getFsReadFile).mockReset();
    vi.mocked(getFsReadFile).mockResolvedValue({
      ok: true,
      data: {
        content: "charter\n",
        path: "/Users/Baden/Appa/AGENTS.md",
        name: "AGENTS.md",
      },
    });
  });

  it("opens a mentioned file the same way as a tree tap", async () => {
    useZenStore.setState({
      fileSource: "live",
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      files: [
        { id: "/Users/Baden/Appa/AGENTS.md", name: "AGENTS.md", body: "" },
      ],
      openFileIds: [],
      focusId: null,
      filesOpen: false,
    });
    useZenStore.getState().openFileFromPath("AGENTS.md");
    expect(useZenStore.getState().openFileIds).toEqual([
      "/Users/Baden/Appa/AGENTS.md",
    ]);
    expect(useZenStore.getState().focusId).toBe("/Users/Baden/Appa/AGENTS.md");
    expect(useZenStore.getState().filesOpen).toBe(true);
    await Promise.resolve();
    expect(getFsReadFile).toHaveBeenCalledWith("/Users/Baden/Appa/AGENTS.md");
  });

  it("opens a nested path that is not in the current listing", async () => {
    useZenStore.setState({
      fileSource: "live",
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      files: [
        { id: "/Users/Baden/Appa/AGENTS.md", name: "AGENTS.md", body: "" },
      ],
      openFileIds: [],
      focusId: null,
      filesOpen: false,
    });
    useZenStore.getState().openFileFromPath("src/zen/ThreadPane.tsx");
    const id = "/Users/Baden/Appa/src/zen/ThreadPane.tsx";
    expect(useZenStore.getState().openFileIds).toEqual([id]);
    expect(useZenStore.getState().files.some((f) => f.id === id)).toBe(true);
    await Promise.resolve();
    expect(getFsReadFile).toHaveBeenCalledWith(id);
  });

  it("does not open a path outside the workspace", () => {
    useZenStore.setState({
      fileSource: "live",
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      files: [],
      openFileIds: [],
    });
    useZenStore.getState().openFileFromPath("/etc/passwd");
    expect(useZenStore.getState().openFileIds).toEqual([]);
    expect(getFsReadFile).not.toHaveBeenCalled();
  });
});
