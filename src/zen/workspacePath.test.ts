import { describe, expect, it } from "vitest";
import {
  looksLikeRootListing,
  ownedWorkspacePath,
  usableFsPath,
} from "./workspacePath";

describe("usableFsPath", () => {
  it("keeps an absolute workspace path", () => {
    expect(usableFsPath("/Users/Baden/Appa")).toBe("/Users/Baden/Appa");
    expect(usableFsPath("/Users/Baden/AI Projects/Skin Test B")).toBe(
      "/Users/Baden/AI Projects/Skin Test B"
    );
  });

  it("rejects root, cwd, tilde, handles, empty, and traversals that resolve to root", () => {
    expect(usableFsPath("/")).toBeNull();
    expect(usableFsPath(".")).toBeNull();
    expect(usableFsPath("~")).toBeNull();
    expect(usableFsPath("~/Appa")).toBeNull();
    expect(usableFsPath("appa")).toBeNull();
    expect(usableFsPath("")).toBeNull();
    expect(usableFsPath(null)).toBeNull();
    expect(usableFsPath("//")).toBeNull();
    expect(usableFsPath("/.")).toBeNull();
    expect(usableFsPath("/./")).toBeNull();
    expect(usableFsPath("/..")).toBeNull();
    expect(usableFsPath("/tmp/..")).toBeNull();
    expect(usableFsPath("/Users/..")).toBeNull();
  });
});

describe("ownedWorkspacePath", () => {
  it("returns the row path only when dir equals that agent's own path", () => {
    expect(
      ownedWorkspacePath("/Users/Baden/Appa", "/Users/Baden/Appa")
    ).toBe("/Users/Baden/Appa");
    expect(ownedWorkspacePath("/Users/Baden", "/Users/Baden/Appa")).toBeNull();
    expect(ownedWorkspacePath("/Users/Baden/Appa", "/Users/Baden")).toBeNull();
    expect(ownedWorkspacePath("/tmp/..", "/tmp/..")).toBeNull();
  });
});

describe("looksLikeRootListing", () => {
  it("catches the macOS root symlink set QA saw", () => {
    expect(
      looksLikeRootListing([
        { name: "etc", path: "/etc" },
        { name: "home", path: "/home" },
        { name: "tmp", path: "/tmp" },
        { name: "var", path: "/var" },
      ])
    ).toBe(true);
  });

  it("lets an agent workspace through", () => {
    expect(
      looksLikeRootListing([
        { name: "AGENTS.md", path: "/Users/Baden/Appa/AGENTS.md" },
        { name: "app", path: "/Users/Baden/Appa/app" },
      ])
    ).toBe(false);
  });
});
