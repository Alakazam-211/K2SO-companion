import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  attachmentCountLabel,
  attachmentErrorText,
  attachmentOpenable,
  attachmentQuery,
  attachmentsKey,
  formatAttachmentSize,
  mapAttachmentError,
  parseAttachmentMeta,
  parseAttachmentPreview,
  parseAttachmentRange,
  parseThreadAttachments,
  withAttachmentState,
} from "./threadAttachmentPure";

const pdf = {
  kind: "file",
  state: "ok",
  path: "docs/report-q3.pdf",
  name: "report-q3.pdf",
  size: 245812,
  mime: "application/pdf",
  modifiedAt: 1760790000000,
  sha256: "9f2c",
};

describe("parseThreadAttachments", () => {
  it("parses the contract example (ok + changed with a line range)", () => {
    const list = parseThreadAttachments([
      pdf,
      { kind: "file", state: "changed", path: "src/session.rs", name: "session.rs", size: 9000, mime: "text/plain", modifiedAt: 1, sha256: "11aa", line: 212, lineEnd: 240 },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ n: 0, kind: "file", state: "ok", name: "report-q3.pdf", size: 245812, mime: "application/pdf", line: null });
    expect(list[1]).toMatchObject({ n: 1, state: "changed", line: 212, lineEnd: 240 });
  });

  it("absent / not an array → none", () => {
    expect(parseThreadAttachments(undefined)).toEqual([]);
    expect(parseThreadAttachments(null)).toEqual([]);
    expect(parseThreadAttachments({ 0: pdf })).toEqual([]);
    expect(parseThreadAttachments("x")).toEqual([]);
  });

  it("skips junk entries but keeps the wire index as n", () => {
    const list = parseThreadAttachments([null, "x", pdf, 7]);
    expect(list).toHaveLength(1);
    expect(list[0].n).toBe(2);
  });

  it("at most 10", () => {
    const list = parseThreadAttachments(Array.from({ length: 14 }, () => pdf));
    expect(list).toHaveLength(MAX_ATTACHMENTS);
    expect(list[9].n).toBe(9);
  });

  it("hidden carries only kind + state, even if the server sent more", () => {
    const [h] = parseThreadAttachments([{ kind: "file", state: "hidden", path: "secret/plan.md", name: "plan.md", size: 5 }]);
    expect(h).toMatchObject({ state: "hidden", path: "", name: "", size: null, mime: "" });
    expect(attachmentOpenable(h)).toBe(false);
  });

  it("unknown kind stays a plain card that never opens", () => {
    const [f] = parseThreadAttachments([{ ...pdf, kind: "folder", path: "docs", name: "docs" }]);
    expect(f.kind).toBe("folder");
    expect(attachmentOpenable(f)).toBe(false);
  });

  it("gone never opens; ok / changed do", () => {
    const [ok, changed, gone] = parseThreadAttachments([pdf, { ...pdf, state: "changed" }, { ...pdf, state: "gone" }]);
    expect(attachmentOpenable(ok)).toBe(true);
    expect(attachmentOpenable(changed)).toBe(true);
    expect(attachmentOpenable(gone)).toBe(false);
  });

  it("name falls back to the path's base; bad numbers drop; lineEnd needs a line", () => {
    const [a] = parseThreadAttachments([{ path: "a/b/c.txt", size: -3, line: 0, lineEnd: 4 }]);
    expect(a).toMatchObject({ kind: "file", state: "ok", name: "c.txt", size: null, line: null, lineEnd: null });
    const [b] = parseThreadAttachments([{ path: "x.rs", line: 10, lineEnd: 4 }]);
    expect(b).toMatchObject({ line: 10, lineEnd: null });
  });

  it("an unknown state with nothing to show reads as hidden", () => {
    expect(parseThreadAttachments([{ kind: "file", state: "weird" }])[0].state).toBe("hidden");
    expect(parseThreadAttachments([{ ...pdf, state: "weird" }])[0].state).toBe("ok");
  });
});

describe("labels", () => {
  it("[file] / [N files]", () => {
    expect(attachmentCountLabel(1)).toBe("[file]");
    expect(attachmentCountLabel(3)).toBe("[3 files]");
    expect(attachmentCountLabel(0)).toBe("");
    expect(attachmentCountLabel(Number.NaN)).toBe("");
  });

  it("sizes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(245812)).toBe("240 KB");
    expect(formatAttachmentSize(48 * 1024 * 1024)).toBe("48.0 MB");
    expect(formatAttachmentSize(null)).toBe("");
  });

  it("attachmentsKey changes with state", () => {
    const a = parseThreadAttachments([pdf]);
    const b = parseThreadAttachments([{ ...pdf, state: "gone" }]);
    expect(attachmentsKey(a)).not.toBe(attachmentsKey(b));
    expect(attachmentsKey(undefined)).toBe("");
  });

  it("withAttachmentState replaces one, same array when unchanged, never un-hides", () => {
    const list = parseThreadAttachments([pdf, { kind: "file", state: "hidden" }]);
    expect(withAttachmentState(list, 0, "ok")).toBe(list);
    const next = withAttachmentState(list, 0, "gone");
    expect(next[0].state).toBe("gone");
    expect(list[0].state).toBe("ok");
    expect(withAttachmentState(list, 1, "ok")).toBe(list);
    expect(withAttachmentState(list, 5, "gone")).toBe(list);
  });
});

describe("attachmentQuery", () => {
  it("addr wins over conversationId; range carries offset/len", () => {
    expect(attachmentQuery({ addr: "sales", conversationId: "c1", id: "6b1e" }, 1, "preview")).toEqual({
      addr: "sales",
      id: "6b1e",
      n: "1",
      mode: "preview",
    });
    expect(attachmentQuery({ conversationId: "c1", id: "6b1e" }, 0, "range", { offset: 4194304, len: 4194304 })).toEqual({
      conversationId: "c1",
      id: "6b1e",
      n: "0",
      mode: "range",
      offset: "4194304",
      len: "4194304",
    });
  });

  it("no Thread or no id → null", () => {
    expect(attachmentQuery({ id: "x" }, 0, "meta")).toBeNull();
    expect(attachmentQuery({ addr: "a", id: "" }, 0, "meta")).toBeNull();
    expect(attachmentQuery({ addr: "a", id: "x" }, -1, "meta")).toBeNull();
  });
});

describe("mapAttachmentError (the contract's table)", () => {
  const j = (v: unknown) => JSON.stringify(v);
  it.each([
    [400, j({ ok: false, error: { code: "usage", hint: "len > 16 MB" } }), "usage"],
    [403, j({ ok: false, error: { code: "forbidden", hint: "agents read from disk" } }), "forbidden"],
    [403, j({ ok: false, error: { code: "skin_room" } }), "forbidden"],
    [403, j({ error: "missing capability files:read" }), "missing_capability"],
    [403, j({ ok: false, error: { code: "cap_not_granted", cap: "files:read", hint: "x" } }), "missing_capability"],
    [403, j({ ok: false, error: { code: "cap_not_granted", cap: "thread:read", hint: "x" } }), "forbidden"],
    [403, j({ ok: false, error: { code: "skin_room", hint: "x" } }), "forbidden"],
    [401, "", "unauthorized"],
    [404, j({ ok: false, error: { code: "not_found" } }), "not_found"],
    [404, j({ ok: false, error: { code: "attachment_gone" } }), "attachment_gone"],
    [415, j({ ok: false, error: { code: "no_preview" } }), "no_preview"],
    [415, "no_preview", "no_preview"],
    [413, j({ ok: false, error: { code: "preview_too_large" } }), "preview_too_large"],
    [405, "", "method_not_allowed"],
    [500, "boom", "http"],
  ])("%i %s → %s", (status, body, code) => {
    expect(mapAttachmentError(status, body).code).toBe(code);
  });

  it("texts", () => {
    expect(attachmentErrorText(mapAttachmentError(404, j({ error: { code: "attachment_gone" } })))).toBe(
      "Not found (moved or deleted)"
    );
    expect(attachmentErrorText(mapAttachmentError(403, j({ error: "missing capability files:read" })))).toMatch(
      /isn't shared with you/
    );
  });
});

describe("response parsers", () => {
  it("meta", () => {
    const r = parseAttachmentMeta({ ok: true, kind: "file", name: "a.pdf", path: "docs/a.pdf", size: 9, mime: "application/pdf", modifiedAt: 2, state: "changed", sent: { size: 8 } });
    expect(r).toEqual({ ok: true, data: expect.objectContaining({ size: 9, state: "changed", name: "a.pdf" }) });
    expect(parseAttachmentMeta(null).ok).toBe(false);
  });

  it("preview text / image / pdf / unknown", () => {
    const t = parseAttachmentPreview({ ok: true, kind: "text", text: "hi", truncated: true, state: "ok" });
    expect(t.ok && t.data.kind === "text" && t.data.truncated).toBe(true);
    const i = parseAttachmentPreview({ ok: true, kind: "image", base64: "AA==", mime: "image/png" });
    expect(i.ok && i.data.kind).toBe("image");
    expect(parseAttachmentPreview({ ok: true, kind: "pdf" }).ok).toBe(false);
    expect(parseAttachmentPreview({ ok: true, kind: "video", base64: "" }).ok).toBe(false);
  });

  it("range", () => {
    expect(parseAttachmentRange({ ok: true, base64: "AA==", len: 1, offset: 0, size: 1, eof: true })).toEqual({
      ok: true,
      data: { base64: "AA==", len: 1, offset: 0, size: 1, eof: true },
    });
    expect(parseAttachmentRange({ ok: true, base64: "AA==" }).ok).toBe(false);
  });
});
