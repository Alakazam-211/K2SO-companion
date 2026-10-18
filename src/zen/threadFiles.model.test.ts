// Thread files (K2 0.46.1 `thread-attachments-v1`): the message model,
// live merge and list-row previews.
import { describe, expect, it } from "vitest";
import { mergeThreadMessages } from "./threadLive";
import { normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { rowLastFromLatest, rowLastFromMessage } from "./lastAtFetch";
import { lastPreview, rowPreviewText } from "./rowPreview";

const file = (over: Record<string, unknown> = {}) => ({
  kind: "file",
  state: "ok",
  path: "docs/report.pdf",
  name: "report.pdf",
  size: 2048,
  mime: "application/pdf",
  modifiedAt: 1,
  sha256: "ab",
  ...over,
});

describe("normaliseThreadItem with attachments", () => {
  it("reads doc.attachments (GET /cli/thread items[].doc)", () => {
    const m = normaliseThreadItem(
      { doc: { id: "d1", seq: 3, kind: "text", from: "sales", body: "The Q3 report", attachments: [file()] } },
      "me"
    )!;
    expect(m.text).toBe("The Q3 report");
    expect(m.files).toHaveLength(1);
    expect(m.files![0]).toMatchObject({ n: 0, name: "report.pdf", state: "ok" });
  });

  it("an overlay frame's doc parses the same way", () => {
    const m = normaliseThreadItem({ collection: "thread", doc: { id: "d2", body: "x", attachments: [file()] } } as never, "me")!;
    expect(m.files?.[0].path).toBe("docs/report.pdf");
  });

  it("an empty body with files is kept (chips, no bubble)", () => {
    const m = normaliseThreadItem({ doc: { id: "d3", kind: "text", from: "sales", body: "", attachments: [file()] } }, "me");
    expect(m).not.toBeNull();
    expect(m!.text).toBe("");
    expect(m!.files).toHaveLength(1);
  });

  it("an empty body without files is still dropped; no files → no field", () => {
    expect(normaliseThreadItem({ doc: { id: "d4", body: "", attachments: [] } }, "me")).toBeNull();
    expect(normaliseThreadItem({ doc: { id: "d5", body: "", attachments: "junk" } }, "me")).toBeNull();
    const m = normaliseThreadItem({ doc: { id: "d6", body: "hi" } }, "me")!;
    expect("files" in m).toBe(false);
  });
});

function msg(id: string, seq: number, files?: ThreadMessage["files"]): ThreadMessage {
  const m: ThreadMessage = { id, seq, text: id, from: "a", at: seq, mine: false, kind: "text", choice: null };
  if (files) m.files = files;
  return m;
}

describe("mergeThreadMessages refreshFiles", () => {
  const ok = normaliseThreadItem({ doc: { id: "a", body: "a", attachments: [file()] } }, "")!.files;
  const gone = normaliseThreadItem({ doc: { id: "a", body: "a", attachments: [file({ state: "gone" })] } }, "")!.files;

  it("a re-read takes the server's new state for a message on screen", () => {
    const cur = [msg("a", 1, ok)];
    const next = mergeThreadMessages(cur, [msg("a", 1, gone)], { refreshFiles: true });
    expect(next).not.toBe(cur);
    expect(next[0].files![0].state).toBe("gone");
  });

  it("live frames (no refreshFiles) never overwrite; same state = same array", () => {
    const cur = [msg("a", 1, gone)];
    expect(mergeThreadMessages(cur, [msg("a", 1, ok)])).toBe(cur);
    expect(mergeThreadMessages(cur, [msg("a", 1, gone)], { refreshFiles: true })).toBe(cur);
  });
});

describe("list rows", () => {
  it("a files-only message previews as [file] / [N files], never a name", () => {
    const one = normaliseThreadItem({ doc: { id: "x", body: "", attachments: [file()] } }, "")!;
    const three = normaliseThreadItem({ doc: { id: "y", body: "", attachments: [file(), file(), file()] } }, "")!;
    expect(rowLastFromMessage(one, "sales", "").text).toBe("[file]");
    expect(rowLastFromMessage(three, "sales", "").text).toBe("[3 files]");
    expect(rowPreviewText(lastPreview(rowLastFromMessage(one, "sales", "")))).toBe("[file]");
    expect(rowPreviewText(lastPreview(rowLastFromMessage(three, "sales", "")))).not.toMatch(/report/);
  });

  it("words win over the count", () => {
    const m = normaliseThreadItem({ doc: { id: "x", body: "Here", attachments: [file()] } }, "")!;
    expect(rowLastFromMessage(m, "sales", "").text).toBe("Here");
  });

  it("thread/latest: attachmentCount fills an empty preview", () => {
    expect(rowLastFromLatest({ addr: "sales", seq: 4, at: 5, preview: "", attachmentCount: 2 }, "")!.text).toBe("[2 files]");
    expect(rowLastFromLatest({ addr: "sales", seq: 4, at: 5, preview: null, attachmentCount: 1 }, "")!.text).toBe("[file]");
    expect(rowLastFromLatest({ addr: "sales", seq: 4, at: 5, preview: "Report [file]", attachmentCount: 1 }, "")!.text).toBe(
      "Report [file]"
    );
    expect(rowLastFromLatest({ addr: "sales", seq: 4, at: 5, preview: "" }, "")!.text).toBe("");
  });
});
