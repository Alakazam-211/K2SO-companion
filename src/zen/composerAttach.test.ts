import { describe, expect, it } from "vitest";
import {
  UPLOAD_DIR,
  attachmentSendBody,
  extensionForType,
  filesFromClipboard,
  safeFilename,
  uploadFilename,
  workspaceHandleOf,
} from "./composerAttach";

describe("composerAttach", () => {
  it("safeFilename strips path and leading dots", () => {
    expect(safeFilename("../../secret.png")).toBe("secret.png");
    expect(safeFilename("")).toBe("");
  });

  it("sidecar addr uploads into the parent workspace handle", () => {
    expect(workspaceHandleOf("appa/1")).toBe("appa");
    expect(workspaceHandleOf("appa")).toBe("appa");
    expect(workspaceHandleOf("")).toBe("");
  });

  it("reads files off a paste DataTransfer", () => {
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const data = {
      files: [file],
      items: [],
    } as unknown as DataTransfer;
    expect(filesFromClipboard(data).map((f) => f.name)).toEqual(["shot.png"]);
  });

  it("names a pasted image without a filename", () => {
    expect(uploadFilename(new File(["x"], "", { type: "image/png" }))).toBe(
      "image.png"
    );
    expect(uploadFilename(new File(["x"], "", { type: "image/jpeg" }))).toBe(
      "image.jpg"
    );
    expect(uploadFilename(new File(["x"], "", { type: "application/pdf" }))).toBe(
      "upload.pdf"
    );
  });

  it("keeps a named file's extension and fills one from the MIME type", () => {
    expect(
      uploadFilename(new File(["x"], "notes", { type: "text/plain" }))
    ).toBe("notes.txt");
    expect(
      uploadFilename(new File(["x"], "photo.HEIC", { type: "image/heic" }))
    ).toBe("photo.HEIC");
    expect(extensionForType("image/webp")).toBe("webp");
    expect(extensionForType("video/quicktime")).toBe("mov");
  });

  it("uploads into the workspace root dir the daemon accepts", () => {
    expect(UPLOAD_DIR).toBe(".");
    expect(UPLOAD_DIR).not.toBe("");
  });

  it("joins a caption with uploaded paths", () => {
    expect(attachmentSendBody("see this", ["/ws/a.png", "/ws/b.pdf"])).toBe(
      "see this\n/ws/a.png\n/ws/b.pdf"
    );
    expect(attachmentSendBody("", ["/ws/a.png"])).toBe("/ws/a.png");
  });
});
