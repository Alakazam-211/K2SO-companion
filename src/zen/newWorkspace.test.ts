import { describe, expect, it } from "vitest";
import {
  canCreateWorkspace,
  createErrorText,
  createRoleNote,
  defaultParentDir,
  newWorkspaceProblem,
  slugifyWorkspaceName,
  workspacePathFor,
} from "./newWorkspace";

describe("slugifyWorkspaceName (desktop slugifyAddressToken twin)", () => {
  it("lowercases, hyphenates spaces and underscores, drops the rest", () => {
    expect(slugifyWorkspaceName("My Project")).toBe("my-project");
    expect(slugifyWorkspaceName("  Side_Quest  2 ")).toBe("side-quest-2");
    expect(slugifyWorkspaceName("Café & Co!")).toBe("caf-co");
    expect(slugifyWorkspaceName("--a---b--")).toBe("a-b");
  });

  it("rejects separators, control chars and empty results", () => {
    expect(slugifyWorkspaceName("a/b")).toBeNull();
    expect(slugifyWorkspaceName("a:b")).toBeNull();
    expect(slugifyWorkspaceName("a\\b")).toBeNull();
    expect(slugifyWorkspaceName("🚀")).toBeNull();
    expect(slugifyWorkspaceName("   ")).toBeNull();
  });
});

describe("workspacePathFor (the path preview)", () => {
  it("joins the parent and slug", () => {
    expect(workspacePathFor("/Users/r/Dev", "my-project")).toBe("/Users/r/Dev/my-project");
    expect(workspacePathFor("/Users/r/Dev/", "x")).toBe("/Users/r/Dev/x");
    expect(workspacePathFor(" /Users//r/./Dev ", "x")).toBe("/Users/r/Dev/x");
  });

  it("needs an absolute parent with no .. and a slug", () => {
    expect(workspacePathFor("Dev", "x")).toBeNull();
    expect(workspacePathFor("~/Dev", "x")).toBeNull();
    expect(workspacePathFor("/Users/../etc", "x")).toBeNull();
    expect(workspacePathFor("/Users/r", null)).toBeNull();
  });
});

describe("defaultParentDir", () => {
  it("is the folder most workspaces share", () => {
    expect(
      defaultParentDir(["/Users/r/Dev/a", "/Users/r/Dev/b", "/Users/r/other/c", null], "/Users/r")
    ).toBe("/Users/r/Dev");
  });

  it("falls back to the host home, then null", () => {
    expect(defaultParentDir([], "/Users/r")).toBe("/Users/r");
    expect(defaultParentDir(["/top"], "/home/r")).toBe("/home/r");
    expect(defaultParentDir([], null)).toBeNull();
  });
});

describe("newWorkspaceProblem", () => {
  it("names the first problem", () => {
    expect(newWorkspaceProblem("", "/d", [])).toBe("Enter a name");
    expect(newWorkspaceProblem("a/b", "/d", [])).toMatch(/letters or numbers/);
    expect(newWorkspaceProblem("ok", "rel", [])).toMatch(/full path/);
    expect(newWorkspaceProblem("Alpha", "/d", ["/d/alpha"])).toBe(
      "A workspace already uses /d/alpha"
    );
    expect(newWorkspaceProblem("Alpha", "/d", ["/d/beta"])).toBeNull();
  });
});

describe("createErrorText", () => {
  it("maps daemon refusals to plain lines", () => {
    expect(createErrorText("role_required", 403)).toMatch(/can’t create workspaces/);
    expect(createErrorText("Directory already exists: /d/x", 400)).toMatch(/folder already exists/);
    expect(createErrorText("workspace already exists x", 400)).toMatch(/already a workspace/);
    expect(createErrorText("Failed to create directory: denied", 400)).toBe(
      "Failed to create directory: denied"
    );
    expect(createErrorText(undefined)).toBe("Could not create the workspace");
  });
});

describe("role gating", () => {
  it("Member and up may create (route_policy: Member)", () => {
    expect(canCreateWorkspace({ owner: true, role: "owner" })).toBe(true);
    expect(canCreateWorkspace({ owner: false, role: "admin" })).toBe(true);
    expect(canCreateWorkspace({ owner: false, role: "member" })).toBe(true);
  });

  it("unknown identity or role defers to the daemon", () => {
    expect(canCreateWorkspace(null)).toBe(true);
    expect(canCreateWorkspace({ owner: false })).toBe(true);
  });

  it("a known role below the requirement is refused", () => {
    expect(canCreateWorkspace({ owner: false, role: "viewer" })).toBe(false);
    expect(canCreateWorkspace({ owner: false, role: "member" }, "admin")).toBe(false);
    expect(canCreateWorkspace({ owner: false, role: "admin" }, "owner")).toBe(false);
    expect(canCreateWorkspace({ owner: true, role: "owner" }, "owner")).toBe(true);
  });

  it("the note names who can", () => {
    expect(createRoleNote("owner")).toBe("Only the server owner can create workspaces");
    expect(createRoleNote("admin")).toMatch(/admins/);
  });
});
