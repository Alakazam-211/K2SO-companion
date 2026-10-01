import { describe, expect, it } from "vitest";
import {
  extrasFromRemembered,
  isOverlaySidecarSuffix,
  mergeSidecarTitles,
  nextSidecarAddr,
  parseCompanionSessions,
  sidecarRenameTarget,
  sidecarSuffix,
  sidecarsFromSessions,
} from "./sidecarRows";

/** d9ba096 openSidecar always minted handle/1. */
function oldOpenSidecarAddr(addr: string): string {
  return `${addr.split("/")[0]}/1`;
}

describe("nextSidecarAddr", () => {
  it("the next unused sidecar is not always /1", () => {
    expect(oldOpenSidecarAddr("appa")).toBe("appa/1");
    expect(oldOpenSidecarAddr("ai-trading-platform")).toBe("ai-trading-platform/1");
    expect(nextSidecarAddr("appa", [])).toBe("appa/1");
    expect(nextSidecarAddr("appa", ["appa/1"])).toBe("appa/2");
    expect(nextSidecarAddr("appa", ["appa/1"])).not.toBe(oldOpenSidecarAddr("appa"));
    expect(nextSidecarAddr("appa", ["appa/1", "appa/2"])).toBe("appa/3");
    expect(nextSidecarAddr("appa", ["appa/reviewer"])).toBe("appa/1");
    expect(nextSidecarAddr("ai-trading-platform", ["ai-trading-platform/1"])).toBe(
      "ai-trading-platform/2"
    );
  });
});

describe("sidecarsFromSessions", () => {
  const appa = { path: "/Users/Baden/Appa", name: "appa", addr: "appa" };
  const trading = {
    path: "/Users/Baden/AI Projects/Trading",
    name: "AI Trading Platform",
    addr: "ai-trading-platform",
  };

  it("lists real server sidecars with the workspace name and the session title", () => {
    const rows = sidecarsFromSessions(
      [
        {
          cwd: "/Users/Baden/Appa",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Baden/AI Projects/Trading",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Baden/Appa",
          agentName: "appa",
          label: "main chat tab",
          isMainChat: true,
        },
      ],
      [appa, trading]
    );
    expect(rows).toEqual([
      { addr: "appa/1", path: appa.path, name: "appa", chatTitle: "1" },
      {
        addr: "ai-trading-platform/1",
        path: trading.path,
        name: "AI Trading Platform",
        chatTitle: "1",
      },
    ]);
    expect(rows[0].name).not.toBe("appa / 1");
    expect(rows[0].chatTitle).not.toBe(rows[0].name);
  });

  it("does not invent a sidecar when the session list is empty", () => {
    expect(sidecarsFromSessions([], [appa])).toEqual([]);
  });

  it("skips a session with no agentName rather than guessing /1", () => {
    expect(
      sidecarsFromSessions(
        [{ cwd: appa.path, label: "mystery", isMainChat: false }],
        [appa]
      )
    ).toEqual([]);
  });

  it("a desktop tab session is not listed as an overlay chat", () => {
    const rows = sidecarsFromSessions(
      [
        {
          cwd: appa.path,
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: appa.path,
          agentName: "tab-dda4b7a4-08f4-4e85-8001-2b5bb9592cf7",
          label: "Get the grok code installed.",
          isMainChat: false,
        },
        {
          cwd: appa.path,
          agentName: "20bb835b-2741-49b1-901d-2733f7c830:hb:project-drive",
          label: "20bb835b-2741-49b1-901d-2733f7c830:hb:project-drive",
          isMainChat: false,
        },
        {
          cwd: appa.path,
          agentName: "tab-beeb4d79-43c3-48f3-aa4e-cc28801eec13",
          label: "tab-beeb4d79-43c3-48f3-aa4e-cc28801eec13",
          isMainChat: false,
        },
      ],
      [appa]
    );
    expect(rows.map((r) => r.addr)).toEqual(["appa/1"]);
    expect(rows.some((r) => (r.addr || "").includes("tab-"))).toBe(false);
    expect(rows.some((r) => (r.addr || "").includes(":hb:"))).toBe(false);
  });
});

describe("isOverlaySidecarSuffix", () => {
  it("keeps overlay suffixes and drops desktop tab ids", () => {
    expect(isOverlaySidecarSuffix("1")).toBe(true);
    expect(isOverlaySidecarSuffix("2")).toBe(true);
    expect(isOverlaySidecarSuffix("reviewer")).toBe(true);
    expect(isOverlaySidecarSuffix("tab-dda4b7a4-08f4-4e85-8001-2b5bb9592cf7")).toBe(
      false
    );
    expect(
      isOverlaySidecarSuffix("20bb835b-2741-49b1-901d-2733f7c830:hb:project-drive")
    ).toBe(false);
  });
});

describe("parseCompanionSessions", () => {
  it("accepts a bare array or {sessions:[]}", () => {
    expect(parseCompanionSessions([{ agentName: "1" }])).toEqual([{ agentName: "1" }]);
    expect(parseCompanionSessions({ sessions: [{ agentName: "2" }] })).toEqual([
      { agentName: "2" },
    ]);
    expect(parseCompanionSessions({ ok: true })).toBeNull();
    expect(parseCompanionSessions(null)).toBeNull();
  });
});

describe("sidecarSuffix", () => {
  it("takes the part after the workspace handle", () => {
    expect(sidecarSuffix("appa/1")).toBe("1");
    expect(sidecarSuffix("sales/reviewer")).toBe("reviewer");
    expect(sidecarSuffix("appa")).toBe("");
  });
});

describe("mergeSidecarTitles", () => {
  it("live session labels win over join-derived suffix titles", () => {
    const rows = mergeSidecarTitles(
      [
        { addr: "skin-test-a/qa088", chatTitle: "qa088" },
        { addr: "skin-test-a", chatTitle: null },
      ],
      [
        {
          addr: "skin-test-a/qa088",
          path: "/ws",
          name: "Skin Test A",
          chatTitle: "Example Sidecar",
          tabId: "tab-1",
          projectId: "proj-1",
        },
      ]
    );
    expect(rows[0]).toMatchObject({
      addr: "skin-test-a/qa088",
      chatTitle: "Example Sidecar",
      tabId: "tab-1",
      projectId: "proj-1",
    });
    expect(rows[1].chatTitle).toBeNull();
  });
});

describe("sidecarRenameTarget", () => {
  it("uses the live session tab and project ids", () => {
    expect(
      sidecarRenameTarget({
        addr: "skin-test-a/qa088",
        path: "/ws",
        sessions: [
          {
            cwd: "/ws",
            agentName: "qa088",
            isMainChat: false,
            tabId: "tab-qa088",
            projectId: "proj-skin",
          },
        ],
        projects: [],
      })
    ).toEqual({ projectId: "proj-skin", tabId: "tab-qa088" });
  });

  it("falls back to the suffix tab id and the workspace project id", () => {
    expect(
      sidecarRenameTarget({
        addr: "skin-test-a/qa088",
        path: "/ws",
        sessions: [],
        projects: [{ id: "proj-skin", path: "/ws" }],
        storedTabId: null,
        storedProjectId: null,
      })
    ).toEqual({ projectId: "proj-skin", tabId: "qa088" });
  });

  it("is null when there is no project id", () => {
    expect(
      sidecarRenameTarget({
        addr: "skin-test-a/qa088",
        path: "/ws",
        sessions: [],
        projects: [],
      })
    ).toBeNull();
  });
});

describe("extrasFromRemembered", () => {
  const appa = { path: "/Users/Baden/Appa", name: "appa", addr: "appa" };

  it("keeps an overlay sidecar after the Mac tab is gone", () => {
    const already = new Set<string>();
    const extra = extrasFromRemembered(
      [{ addr: "appa/1", path: "/Users/Baden/Appa", name: "appa", chatTitle: "1" }],
      already,
      [appa]
    );
    expect(extra).toEqual([
      { addr: "appa/1", path: "/Users/Baden/Appa", name: "appa", chatTitle: "1" },
    ]);
  });

  it("does not duplicate a sidecar the session list already has", () => {
    const already = new Set(["appa/1"]);
    expect(
      extrasFromRemembered(
        [{ addr: "appa/1", path: "/Users/Baden/Appa", name: "appa", chatTitle: "1" }],
        already,
        [appa]
      )
    ).toEqual([]);
  });

  it("does not restore a desktop PTY suffix or a workspace with no main chat", () => {
    expect(
      extrasFromRemembered(
        [{ addr: "appa/tab-abc", path: "/Users/Baden/Appa", name: "appa", chatTitle: "tab" }],
        new Set(),
        [appa]
      )
    ).toEqual([]);
    expect(
      extrasFromRemembered(
        [{ addr: "gone/1", path: "/tmp/gone", name: "gone", chatTitle: "1" }],
        new Set(),
        [appa]
      )
    ).toEqual([]);
  });
});
