// Home rows across servers (multi-server S3b, HM3): resolution on each
// row's own server, rename repair, and flag-off parity of the resolver.
import { describe, expect, it } from "vitest";
import type { ServerEntry } from "../stores/servers";
import { homeAddress } from "./homes";
import { renameRepairFor, resolveHomeRows, savedServerForHost, type ServerLists } from "./homeView";
import type { ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";

const A: ServerEntry = { id: "a", nickname: "Alpha", url: "https://alpha.k2.dev", username: "u", rememberPassword: false };
const B: ServerEntry = { id: "b", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };
const B2: ServerEntry = { id: "b2", nickname: "Bravo again", url: "https://BRAVO.k2.dev:443", username: "v", rememberPassword: false };

function proj(id: string, handle: string | null, path: string, name = handle ?? id): ServerProject {
  return { id, name, handle, path, pinned: false, tabOrder: 0, focusGroupId: null };
}
function agent(addr: string, path: string): StubAgent {
  return { id: path, name: addr, initial: addr[0].toUpperCase(), path, addr, kind: "agent" };
}

const BLISTS: ServerLists = {
  agents: [agent("docs", "/srv/docs"), agent("ops", "/srv/ops")],
  serverProjects: [proj("pd", "docs", "/srv/docs"), proj("po", "ops", "/srv/ops")],
  loadedAt: 1,
};

describe("resolveHomeRows across servers", () => {
  const base = { activeHostKey: "alpha.k2.dev", agents: [agent("alpha", "/a")], projects: [proj("pa", "alpha", "/a")], servers: [A, B] };

  it("flag off: a B row only names its server (no resolution)", () => {
    const [v] = resolveHomeRows([{ address: homeAddress("docs", "bravo.k2.dev"), workspaceId: "pd", label: "docs" }], base);
    expect(v).toEqual({ kind: "remote", row: expect.anything(), server: B, serverLabel: "Bravo" });
  });

  it("flag on: resolves on B's own lists — handle wins, workspace id finds a renamed one", () => {
    const views = resolveHomeRows(
      [
        { address: homeAddress("docs", "bravo.k2.dev"), workspaceId: "po", label: "docs" },
        { address: homeAddress("gone", "bravo.k2.dev"), workspaceId: "po", label: "renamed" },
        { address: homeAddress("lost", "bravo.k2.dev"), workspaceId: "zz", label: "lost" },
        { address: homeAddress("alpha", "alpha.k2.dev"), workspaceId: "pa", label: "alpha" },
      ],
      { ...base, remote: { byServer: { b: BLISTS } } }
    );
    const [docs, renamed, lost, here] = views;
    expect(docs.kind === "remote" && docs.resolved).toEqual({ loaded: true, agent: BLISTS.agents[0], workspaceId: "pd" });
    expect(renamed.kind === "remote" && renamed.resolved?.agent?.addr).toBe("ops");
    expect(lost.kind === "remote" && lost.resolved).toEqual({ loaded: true, agent: null, workspaceId: "zz" });
    // The active server's rows never read another server's lists.
    expect(here.kind).toBe("here");
  });

  it("flag on, B not read yet: unresolved, keeps the stored workspace id", () => {
    const [v] = resolveHomeRows(
      [{ address: homeAddress("docs", "bravo.k2.dev"), workspaceId: "pd", label: "docs" }],
      { ...base, remote: { byServer: {} } }
    );
    expect(v.kind === "remote" && v.resolved).toEqual({ loaded: false, agent: null, workspaceId: "pd" });
  });

  it("two entries share a host key: the one with a login answers (MS2, MA35)", () => {
    expect(savedServerForHost([B2, B], "bravo.k2.dev")?.id).toBe("b2");
    expect(savedServerForHost([B2, B], "bravo.k2.dev", { b: "tok" })?.id).toBe("b");
  });
});

describe("renameRepairFor (desktop repairFromList)", () => {
  const fix = renameRepairFor("bravo.k2.dev", [proj("pd", "docs-v2", "/srv/docs", "Docs v2"), proj("po", "ops", "/srv/ops")]);

  it("a handle gone from its server follows the stored workspace id", () => {
    expect(fix({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "docs" })).toEqual({
      address: "docs-v2::bravo.k2.dev",
      workspaceId: "pd",
      label: "Docs v2",
    });
  });

  it("leaves a row whose handle is still listed, has no id, an unknown id, or another host", () => {
    expect(fix({ address: "ops::bravo.k2.dev", workspaceId: "pd", label: "ops" })).toBeNull();
    expect(fix({ address: "gone::bravo.k2.dev", workspaceId: null, label: "gone" })).toBeNull();
    expect(fix({ address: "gone::bravo.k2.dev", workspaceId: "zz", label: "gone" })).toBeNull();
    expect(fix({ address: "docs::alpha.k2.dev", workspaceId: "pd", label: "docs" })).toBeNull();
  });

  it("a handle still on the Agents list (no project handle) is not repaired; an empty list repairs nothing", () => {
    const withAgent = renameRepairFor("bravo.k2.dev", [proj("pd", "docs-v2", "/srv/docs")], [agent("docs", "/x")]);
    expect(withAgent({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "docs" })).toBeNull();
    expect(renameRepairFor("bravo.k2.dev", [])({ address: "docs::bravo.k2.dev", workspaceId: "pd", label: "d" })).toBeNull();
  });
});
