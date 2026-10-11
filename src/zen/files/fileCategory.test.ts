import { describe, expect, it } from "vitest";
import {
  getFileCategory,
  getFileExtension,
  isBinaryPreviewCategory,
  isTsvPath,
  mediaMimeFromPath,
  supportsSourceToggle,
} from "./fileCategory";

describe("getFileCategory (desktop fileCategory.ts port)", () => {
  it.each([
    ["/ws/README.md", "markdown"],
    ["/ws/notes.MARKDOWN", "markdown"],
    ["/ws/page.mdx", "markdown"],
    ["/ws/index.html", "html"],
    ["/ws/old.htm", "html"],
    ["/ws/a.png", "image"],
    ["/ws/a.JPG", "image"],
    ["/ws/a.svg", "image"],
    ["/ws/a.heic", "image"],
    ["/ws/brief.pdf", "pdf"],
    ["/ws/spec.docx", "docx"],
    ["/ws/legacy.doc", "docx"],
    ["/ws/data.csv", "csv"],
    ["/ws/data.tsv", "csv"],
    ["/ws/a.mp3", "audio"],
    ["/ws/a.m4a", "audio"],
    ["/ws/a.mov", "video"],
    ["/ws/a.mp4", "video"],
    ["/ws/bundle.zip", "zip"],
    ["/ws/flow.mmd", "mermaid"],
    ["/ws/flow.mermaid", "mermaid"],
    ["/ws/g.dot", "diagram"],
    ["/ws/g.puml", "diagram"],
    ["/ws/g.drawio", "diagram"],
    ["/ws/app.wasm", "binary"],
    ["/ws/font.woff2", "binary"],
    ["/ws/package.json", "json"],
    ["/ws/main.rs", "text"],
    ["/ws/Makefile", "text"],
    ["/ws/.env", "text"],
  ])("%s → %s", (path, cat) => {
    expect(getFileCategory(path)).toBe(cat);
  });

  it("reads the extension from the file name, not a dotted folder", () => {
    expect(getFileExtension("/ws/v1.2/README")).toBe("");
    expect(getFileCategory("/ws/site.v2/Dockerfile")).toBe("text");
    expect(getFileExtension("/ws/a.tar.gz")).toBe(".gz");
  });

  it("binary preview categories load bytes, not text", () => {
    for (const c of ["image", "pdf", "docx", "audio", "video", "zip", "binary"] as const) {
      expect(isBinaryPreviewCategory(c)).toBe(true);
    }
    for (const c of ["markdown", "html", "csv", "mermaid", "diagram", "json", "text"] as const) {
      expect(isBinaryPreviewCategory(c)).toBe(false);
    }
  });

  it("Source toggle is for rendered text views only", () => {
    expect(supportsSourceToggle("markdown")).toBe(true);
    expect(supportsSourceToggle("html")).toBe(true);
    expect(supportsSourceToggle("csv")).toBe(true);
    expect(supportsSourceToggle("mermaid")).toBe(true);
    expect(supportsSourceToggle("text")).toBe(false);
    expect(supportsSourceToggle("image")).toBe(false);
  });

  it("media MIME and TSV detection", () => {
    expect(mediaMimeFromPath("/a/b.mp3")).toBe("audio/mpeg");
    expect(mediaMimeFromPath("/a/b.mov")).toBe("video/quicktime");
    expect(mediaMimeFromPath("/a/b.xyz")).toBe("application/octet-stream");
    expect(isTsvPath("/a/b.TSV")).toBe(true);
    expect(isTsvPath("/a/b.csv")).toBe(false);
  });
});

describe("CAD categories", () => {
  it.each([
    ["/ws/k2-bracket.dxf", "cad2d"],
    ["/ws/PLAN.DXF", "cad2d"],
    ["/ws/k2-bracket.stl", "model3d"],
    ["/ws/k2-cube.obj", "model3d"],
    ["/ws/k2-bracket.3mf", "model3d"],
    ["/ws/scan.ply", "model3d"],
    ["/ws/scene.glb", "model3d"],
    ["/ws/scene.gltf", "model3d"],
  ])("%s → %s", (path, cat) => {
    expect(getFileCategory(path)).toBe(cat);
  });

  it(".obj is a 3D model now, not a binary blob", () => {
    expect(getFileCategory("/ws/build/main.obj")).not.toBe("binary");
    expect(getFileCategory("/ws/build/main.o")).toBe("binary");
  });

  it("3D models load bytes; DXF is read as text and offers Source", () => {
    expect(isBinaryPreviewCategory("model3d")).toBe(true);
    expect(isBinaryPreviewCategory("cad2d")).toBe(false);
    expect(supportsSourceToggle("cad2d")).toBe(true);
    expect(supportsSourceToggle("model3d")).toBe(false);
  });
});
