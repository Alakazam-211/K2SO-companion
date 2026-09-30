import { describe, expect, it } from "vitest";
import {
  isOverlaySidecarSuffix,
  nextSidecarAddr,
  parseCompanionSessions,
  sidecarSuffix,
  sidecarsFromSessions,
} from "./sidecarRows";

/** d9ba096 openSidecar always minted handle/1. */
function oldOpenSidecarAddr(addr: string): string {
  return `${addr.split("/")[0]}/1`;
}

describe("nextSidecarAddr", () => {
  it("the next unused sidecar is not always /1", () => {
    expect(oldOpenSidecarAddr("aspen")).toBe("aspen/1");
    expect(oldOpenSidecarAddr("ai-trading-platform")).toBe("ai-trading-platform/1");
    expect(nextSidecarAddr("aspen", [])).toBe("aspen/1");
    expect(nextSidecarAddr("aspen", ["aspen/1"])).toBe("aspen/2");
    expect(nextSidecarAddr("aspen", ["aspen/1"])).not.toBe(oldOpenSidecarAddr("aspen"));
    expect(nextSidecarAddr("aspen", ["aspen/1", "aspen/2"])).toBe("aspen/3");
    expect(nextSidecarAddr("aspen", ["aspen/reviewer"])).toBe("aspen/1");
    expect(nextSidecarAddr("ai-trading-platform", ["ai-trading-platform/1"])).toBe(
      "ai-trading-platform/2"
    );
  });
});

describe("sidecarsFromSessions", () => {
  const aspen = { path: "/Users/Bob/Aspen", name: "aspen", addr: "aspen" };
  const trading = {
    path: "/Users/Bob/AI Projects/Trading",
    name: "AI Trading Platform",
    addr: "ai-trading-platform",
  };

  it("lists real server sidecars with the workspace name and the session title", () => {
    const rows = sidecarsFromSessions(
      [
        {
          cwd: "/Users/Bob/Aspen",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Bob/AI Projects/Trading",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Bob/Aspen",
          agentName: "aspen",
          label: "main chat tab",
          isMainChat: true,
        },
      ],
      [aspen, trading]
    );
    expect(rows).toEqual([
      { addr: "aspen/1", path: aspen.path, name: "aspen", chatTitle: "1" },
      {
        addr: "ai-trading-platform/1",
        path: trading.path,
        name: "AI Trading Platform",
        chatTitle: "1",
      },
    ]);
    expect(rows[0].name).not.toBe("aspen / 1");
    expect(rows[0].chatTitle).not.toBe(rows[0].name);
  });

  it("does not invent a sidecar when the session list is empty", () => {
    expect(sidecarsFromSessions([], [aspen])).toEqual([]);
  });

  it("skips a session with no agentName rather than guessing /1", () => {
    expect(
      sidecarsFromSessions(
        [{ cwd: aspen.path, label: "mystery", isMainChat: false }],
        [aspen]
      )
    ).toEqual([]);
  });

  it("a desktop tab session is not listed as an overlay chat", () => {
    const rows = sidecarsFromSessions(
      [
        {
          cwd: aspen.path,
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: aspen.path,
          agentName: "tab-dda4b7a4-08f4-4e85-8001-2b5bb9592cf7",
          label: "Get the grok code installed.",
          isMainChat: false,
        },
        {
          cwd: aspen.path,
          agentName: "20bb835b-2741-49b1-901d-2733f7c830:hb:project-drive",
          label: "20bb835b-2741-49b1-901d-2733f7c830:hb:project-drive",
          isMainChat: false,
        },
        {
          cwd: aspen.path,
          agentName: "tab-beeb4d79-43c3-48f3-aa4e-cc28801eec13",
          label: "tab-beeb4d79-43c3-48f3-aa4e-cc28801eec13",
          isMainChat: false,
        },
      ],
      [aspen]
    );
    expect(rows.map((r) => r.addr)).toEqual(["aspen/1"]);
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
    expect(sidecarSuffix("aspen/1")).toBe("1");
    expect(sidecarSuffix("sales/reviewer")).toBe("reviewer");
    expect(sidecarSuffix("aspen")).toBe("");
  });
});
