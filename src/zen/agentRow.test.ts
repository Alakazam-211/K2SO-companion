import { describe, expect, it } from "vitest";
import {
  JOIN_NO_AGENT,
  JOIN_NO_HANDLE,
  JOIN_NO_PATH,
  JOIN_NO_PROJECT,
  cliProjectOf,
  joinAgentsWithProjects,
  ownerAgentOf,
  parseCliProjects,
  parseOwnerAgents,
  parseSkinAgents,
  skinInitials,
  skinRoomOf,
} from "./agentRow";

describe("skinRoomOf", () => {
  it("uses handle as addr and displayName as the label; no handle is dropped", () => {
    expect(
      skinRoomOf({
        handle: "skin-test-a",
        displayName: "Skin Test A",
        projectId: "uuid",
      })
    ).toEqual({ handle: "skin-test-a", name: "Skin Test A" });
    expect(skinRoomOf({ handle: "teton" })).toEqual({
      handle: "teton",
      name: "teton",
    });
    expect(skinRoomOf({ displayName: "Denali" })).toBeNull();
    expect(skinRoomOf({})).toBeNull();
  });

  it("blank handle is dropped; leftover roomHandle is not read", () => {
    const raw = { handle: "", displayName: "Teton", roomHandle: "teton" };
    expect(skinRoomOf(raw)).toBeNull();
  });
});

describe("parseSkinAgents", () => {
  it("accepts {agents:[]} only — live 200 is an object, not a bare array", () => {
    expect(parseSkinAgents({ agents: [{ handle: "b" }] })).toEqual([{ handle: "b" }]);
    expect(parseSkinAgents({ agents: [] })).toEqual([]);
    expect(parseSkinAgents([{ handle: "a" }])).toBeNull();
    expect(parseSkinAgents(null)).toBeNull();
    expect(parseSkinAgents({ ok: true })).toBeNull();
  });
});

describe("parseOwnerAgents / ownerAgentOf", () => {
  it("reads {ok,agents} from /cli/agent/list; names include appa and Skin Test; no invented addr", () => {
    const data = {
      ok: true,
      agents: [
        { enabled: true, live: false, mode: "local", name: "appa", path: "/Users/Baden/Appa" },
        { enabled: true, live: false, mode: "local", name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A" },
        { enabled: false, live: false, mode: "local", name: "k2so-agent", path: "/Users/Baden/AI Projects/K2SO Agent" },
      ],
    };
    const rows = parseOwnerAgents(data);
    expect(rows).not.toBeNull();
    const mapped = rows!.map(ownerAgentOf);
    expect(mapped.map((a) => a && a.name)).toEqual(["appa", "Skin Test A", "k2so-agent"]);
    expect(mapped[0]).toEqual({
      id: "appa",
      name: "appa",
      path: "/Users/Baden/Appa",
      addr: null,
    });
    expect(mapped[1]?.addr).toBeNull();
  });

  it("rejects a bare array — that is /cli/agents/list (skills)", () => {
    expect(parseOwnerAgents([{ name: "k2-cli", agentType: "skill" }])).toBeNull();
  });

  it("uses handle as addr only when the wire actually sends it", () => {
    expect(
      ownerAgentOf({ name: "appa", path: "/ws", handle: "appa" })?.addr
    ).toBe("appa");
  });
});

describe("parseCliProjects / cliProjectOf", () => {
  it("reads a bare array; handle and path come from the wire", () => {
    const data = [
      { name: "appa", handle: "appa", path: "/Users/Baden/Appa" },
      { name: "Skin Test A", handle: "skin-test-a", path: "/Users/Baden/AI Projects/Skin Test A" },
      { name: "K2 Companion QA", handle: "k2so-companion-qa", path: "/Users/Baden/AI Projects/K2SO Companion QA" },
      { name: "Skydio", handle: "manager-2", path: "/Users/Baden/AI Projects/Skydio" },
    ];
    const rows = parseCliProjects(data);
    expect(rows).not.toBeNull();
    const mapped = rows!.map(cliProjectOf);
    expect(mapped.map((a) => a && a.handle)).toEqual([
      "appa",
      "skin-test-a",
      "k2so-companion-qa",
      "manager-2",
    ]);
    expect(mapped[2]).toEqual({
      name: "K2 Companion QA",
      path: "/Users/Baden/AI Projects/K2SO Companion QA",
      handle: "k2so-companion-qa",
    });
    expect(mapped[3]?.handle).toBe("manager-2");
  });

  it("rejects {ok,agents} — that is /cli/agent/list, not the address book", () => {
    expect(
      parseCliProjects({ ok: true, agents: [{ name: "appa", path: "/Users/Baden/Appa" }] })
    ).toBeNull();
  });

  it("rejects a skills enumerator — no handle+path on the rows", () => {
    expect(parseCliProjects([{ name: "k2-cli", agentType: "skill" }])).toBeNull();
  });
});

describe("joinAgentsWithProjects", () => {
  it("joins on path and takes handle from the project row, including handles that do not resemble the name", () => {
    const joined = joinAgentsWithProjects(
      [
        { name: "appa", path: "/Users/Baden/Appa" },
        { name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A" },
        { name: "K2 Companion QA", path: "/Users/Baden/AI Projects/K2SO Companion QA" },
        { name: "Skydio", path: "/Users/Baden/AI Projects/Skydio" },
      ],
      [
        { name: "appa", path: "/Users/Baden/Appa", handle: "appa" },
        { name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A", handle: "skin-test-a" },
        { name: "K2 Companion QA", path: "/Users/Baden/AI Projects/K2SO Companion QA", handle: "k2so-companion-qa" },
        { name: "Skydio", path: "/Users/Baden/AI Projects/Skydio", handle: "manager-2" },
      ]
    );
    expect(joined.map((r) => [r.name, r.addr, r.joinMiss])).toEqual([
      ["appa", "appa", null],
      ["Skin Test A", "skin-test-a", null],
      ["K2 Companion QA", "k2so-companion-qa", null],
      ["Skydio", "manager-2", null],
    ]);
  });

  it("does not join on display name when paths differ", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "Skydio", path: "/Users/Baden/AI Projects/Skydio" }],
      [{ name: "Skydio", path: "/somewhere/else", handle: "manager-2" }]
    );
    expect(joined).toHaveLength(2);
    expect(joined[0]).toMatchObject({
      name: "Skydio",
      path: "/Users/Baden/AI Projects/Skydio",
      addr: null,
      joinMiss: JOIN_NO_PROJECT,
    });
    expect(joined[1]).toMatchObject({
      name: "Skydio",
      path: "/somewhere/else",
      addr: null,
      joinMiss: JOIN_NO_AGENT,
    });
    expect(joined.some((r) => r.addr === "manager-2")).toBe(false);
  });

  it("keeps an agent-only path visible and not chattable", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "appa", path: "/Users/Baden/Appa" }],
      []
    );
    expect(joined).toEqual([
      {
        id: "/Users/Baden/Appa",
        name: "appa",
        path: "/Users/Baden/Appa",
        addr: null,
        joinMiss: JOIN_NO_PROJECT,
      },
    ]);
  });

  it("keeps a project-only path visible and not chattable — does not use its handle", () => {
    const joined = joinAgentsWithProjects(
      [],
      [{ name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A", handle: "skin-test-a" }]
    );
    expect(joined).toEqual([
      {
        id: "/Users/Baden/AI Projects/Skin Test A",
        name: "Skin Test A",
        path: "/Users/Baden/AI Projects/Skin Test A",
        addr: null,
        joinMiss: JOIN_NO_AGENT,
      },
    ]);
  });

  it("a joined path with an empty handle is not chattable", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "appa", path: "/Users/Baden/Appa" }],
      [{ name: "appa", path: "/Users/Baden/Appa", handle: null }]
    );
    expect(joined[0]).toMatchObject({
      addr: null,
      joinMiss: JOIN_NO_HANDLE,
    });
  });

  it("joins paths that differ only by a trailing slash", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "appa", path: "/Users/Baden/Appa/" }],
      [{ name: "appa", path: "/Users/Baden/Appa", handle: "appa" }]
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      addr: "appa",
      joinMiss: null,
      path: "/Users/Baden/Appa",
    });
  });

  it("an empty path cannot join", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "orphan", path: "" }],
      [{ name: "book", path: "", handle: "book" }]
    );
    expect(joined.every((r) => r.addr === null)).toBe(true);
    expect(joined.every((r) => r.joinMiss === JOIN_NO_PATH)).toBe(true);
    expect(joined).toHaveLength(2);
  });
});

describe("skinInitials", () => {
  it("takes up to two letters from the display name", () => {
    expect(skinInitials("Skin Test A")).toBe("ST");
    expect(skinInitials("appa")).toBe("A");
  });
});
