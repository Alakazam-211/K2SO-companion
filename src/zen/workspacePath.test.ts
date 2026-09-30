import { describe, expect, it } from "vitest";
import {
  looksLikeRootListing,
  usableFsPath,
} from "./workspacePath";

describe("usableFsPath", () => {
  it("keeps an absolute workspace path", () => {
    expect(usableFsPath("/Users/Baden/Appa")).toBe("/Users/Baden/Appa");
  });

  it("rejects root, cwd, tilde, handles, and empty", () => {
    expect(usableFsPath("/")).toBeNull();
    expect(usableFsPath(".")).toBeNull();
    expect(usableFsPath("~")).toBeNull();
    expect(usableFsPath("~/Appa")).toBeNull();
    expect(usableFsPath("appa")).toBeNull();
    expect(usableFsPath("")).toBeNull();
    expect(usableFsPath(null)).toBeNull();
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
