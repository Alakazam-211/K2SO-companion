import { describe, expect, it } from "vitest";
import {
  classifyHref,
  fileRefFromHref,
  isWebUrl,
  linkifyFileMentions,
  looksLikeFileRef,
  resolveFileRef,
} from "./chatLinks";

describe("classifyHref", () => {
  it("opens http(s) in the browser", () => {
    expect(classifyHref("https://k2.dev")).toBe("web");
    expect(classifyHref("http://127.0.0.1:1420")).toBe("web");
    expect(classifyHref("mailto:baden@example.com")).toBe("web");
  });

  it("treats file paths as files", () => {
    expect(classifyHref("AGENTS.md")).toBe("file");
    expect(classifyHref("src/zen/ThreadPane.tsx")).toBe("file");
    expect(classifyHref("/Users/Baden/Appa/AGENTS.md")).toBe("file");
    expect(classifyHref("file:///Users/Baden/Appa/AGENTS.md")).toBe("file");
  });

  it("drops javascript and data urls", () => {
    expect(classifyHref("javascript:alert(1)")).toBe("none");
    expect(classifyHref("data:text/html,x")).toBe("none");
  });
});

describe("looksLikeFileRef", () => {
  it("accepts names with an extension or a slash", () => {
    expect(looksLikeFileRef("AGENTS.md")).toBe(true);
    expect(looksLikeFileRef("src/foo.ts")).toBe(true);
    expect(looksLikeFileRef("./bar.json")).toBe(true);
  });

  it("rejects bare words and urls", () => {
    expect(looksLikeFileRef("ok")).toBe(false);
    expect(looksLikeFileRef("true")).toBe(false);
    expect(looksLikeFileRef("https://k2.dev")).toBe(false);
    expect(looksLikeFileRef("hello world.md")).toBe(false);
  });
});

describe("resolveFileRef", () => {
  const ws = "/Users/Baden/Appa";

  it("joins a relative path under the workspace", () => {
    expect(resolveFileRef("AGENTS.md", ws)).toBe("/Users/Baden/Appa/AGENTS.md");
    expect(resolveFileRef("src/zen/ThreadPane.tsx", ws)).toBe(
      "/Users/Baden/Appa/src/zen/ThreadPane.tsx"
    );
  });

  it("keeps an absolute path that is already under the workspace", () => {
    expect(resolveFileRef("/Users/Baden/Appa/README.md", ws)).toBe(
      "/Users/Baden/Appa/README.md"
    );
  });

  it("rejects a path that climbs out of the workspace", () => {
    expect(resolveFileRef("../Skin Test A/x", ws)).toBeNull();
    expect(resolveFileRef("/etc/passwd", ws)).toBeNull();
  });
});

describe("fileRefFromHref", () => {
  it("strips file://", () => {
    expect(fileRefFromHref("file:///Users/Baden/Appa/AGENTS.md")).toBe(
      "/Users/Baden/Appa/AGENTS.md"
    );
  });
});

describe("linkifyFileMentions", () => {
  it("turns @file mentions into markdown links", () => {
    expect(linkifyFileMentions("see @AGENTS.md")).toBe("see [AGENTS.md](AGENTS.md)");
    expect(linkifyFileMentions("open @src/foo.ts now")).toBe(
      "open [src/foo.ts](src/foo.ts) now"
    );
  });

  it("does not rewrite emails", () => {
    expect(linkifyFileMentions("write baden@gmail.com")).toBe(
      "write baden@gmail.com"
    );
  });
});

describe("isWebUrl", () => {
  it("accepts http(s)", () => {
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("AGENTS.md")).toBe(false);
  });
});
