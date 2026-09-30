import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  getToken: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getFsReadDir: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
}));

import {
  getAgentList,
  getCliProjectsList,
  getFsReadDir,
  getThread,
  getToken,
  postThread,
} from "../api/client";
import { JOIN_NO_AGENT, JOIN_NO_PROJECT } from "./agentRow";
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
  });
}

describe("signed-in hydrate never exposes the stub catalogue", () => {
  beforeEach(() => {
    reset();
    vi.mocked(getToken).mockReturnValue("tok");
    vi.mocked(getAgentList).mockReset();
    vi.mocked(getCliProjectsList).mockReset();
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: true, data: [] });
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
    vi.mocked(postThread).mockReset();
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

  it("refuses to POST to a room that is not a named test addr", async () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
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
    await useZenStore.getState().sendThread("hello");
    const s = useZenStore.getState();
    expect(postThread).not.toHaveBeenCalled();
    expect(s.thread.map((m) => m.id)).toEqual(["old"]);
    expect(s.sendError).toMatch(/only posts to skin-test-a or k2so-companion-qa/);
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
