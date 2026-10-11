import { describe, expect, it } from "vitest";
import {
  attachPathsToDraft,
  attachmentSendBody,
  composeDropPayload,
  insertIntoDraft,
  extensionForType,
  filesFromClipboard,
  safeFilename,
  uploadDirOf,
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

  it("uploads into the workspace's .k2/downloads folder (desktop's destination)", () => {
    expect(uploadDirOf("/Users/Baden/Appa")).toBe("/Users/Baden/Appa/.k2/downloads");
    expect(uploadDirOf("/Users/Baden/Appa/")).toBe("/Users/Baden/Appa/.k2/downloads");
    expect(uploadDirOf("/Users/Baden/AI Projects/Skin Test B")).toBe(
      "/Users/Baden/AI Projects/Skin Test B/.k2/downloads"
    );
    expect(uploadDirOf(".")).toBeNull();
    expect(uploadDirOf("")).toBeNull();
    expect(uploadDirOf("/")).toBeNull();
    expect(uploadDirOf("appa")).toBeNull();
  });

  it("keeps the picked name: no timestamp, no client-side de-dupe (the daemon writes `name (1).ext`)", () => {
    // Desktop sends `file.name` as is; the daemon sanitises it and picks a
    // collision-free `stem (n).ext`. Two picks of one name send one name.
    const a = new File(["x"], "shot.png", { type: "image/png" });
    const b = new File(["y"], "shot.png", { type: "image/png" });
    expect(uploadFilename(a)).toBe("shot.png");
    expect(uploadFilename(b)).toBe("shot.png");
  });

  it("formats paths like desktop's compose bar", () => {
    expect(composeDropPayload(["/ws/.k2/downloads/a.png"])).toBe("/ws/.k2/downloads/a.png ");
    // Images (and PDFs): single-quoted when not plain.
    expect(composeDropPayload(["/ws/.k2/downloads/shot (1).png"])).toBe(
      "'/ws/.k2/downloads/shot (1).png' "
    );
    expect(composeDropPayload(["/ws/.k2/downloads/it's.pdf"])).toBe(
      "'/ws/.k2/downloads/it'\\''s.pdf' "
    );
    // Other files: backslash-escaped.
    expect(composeDropPayload(["/ws/.k2/downloads/my notes (1).txt"])).toBe(
      "/ws/.k2/downloads/my\\ notes\\ \\(1\\).txt "
    );
    expect(composeDropPayload(["/a.png", "/b.txt"])).toBe("/a.png /b.txt ");
    expect(composeDropPayload([])).toBe("");
  });

  it("inserts into a draft like desktop's insertIntoDraft", () => {
    expect(insertIntoDraft("", "/a.png ", null)).toBe("/a.png ");
    expect(insertIntoDraft("read", "/a.png ", null)).toBe("read /a.png ");
    expect(insertIntoDraft("read ", "/a.png ", null)).toBe("read /a.png ");
    expect(insertIntoDraft("ab", "/a.png ", 1)).toBe("a /a.png b");
    expect(attachPathsToDraft("read this", ["/ws/.k2/downloads/note.txt"])).toBe(
      "read this /ws/.k2/downloads/note.txt "
    );
  });

  it("send body: caption then the downloads paths, trimmed like desktop's send", () => {
    expect(
      attachmentSendBody("see this", ["/ws/.k2/downloads/a.png", "/ws/.k2/downloads/b.pdf"])
    ).toBe("see this /ws/.k2/downloads/a.png /ws/.k2/downloads/b.pdf");
    expect(attachmentSendBody("", ["/ws/.k2/downloads/a.png"])).toBe("/ws/.k2/downloads/a.png");
    expect(attachmentSendBody("  hi  ", [])).toBe("hi");
  });
});
