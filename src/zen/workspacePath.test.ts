import { describe, expect, it } from "vitest";
import {
  looksLikeRootListing,
  usableFsPath,
} from "./workspacePath";

describe("usableFsPath", () => {
  it("keeps an absolute workspace path", () => {
    expect(usableFsPath("/Users/Bob/Aspen")).toBe("/Users/Bob/Aspen");
  });

  it("rejects root, cwd, tilde, handles, and empty", () => {
    expect(usableFsPath("/")).toBeNull();
    expect(usableFsPath(".")).toBeNull();
    expect(usableFsPath("~")).toBeNull();
    expect(usableFsPath("~/Aspen")).toBeNull();
    expect(usableFsPath("aspen")).toBeNull();
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
        { name: "AGENTS.md", path: "/Users/Bob/Aspen/AGENTS.md" },
        { name: "app", path: "/Users/Bob/Aspen/app" },
      ])
    ).toBe(false);
  });
});
