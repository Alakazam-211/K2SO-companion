// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { __resetScopesForTests, scopeFor } from "./scope";
import { useServersStore } from "../stores/servers";
import { downloadAttachment, getAttachmentMeta, getAttachmentPreview } from "./threadAttachment";

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const b64 = (s: string) => btoa(s);

type Call = { url: URL; headers: Record<string, string> };
const calls = (): Call[] =>
  tauriFetch.mock.calls.map(([u, init]) => ({
    url: new URL(u as string),
    headers: ((init as { headers?: Record<string, string> })?.headers ?? {}) as Record<string, string>,
  }));

beforeEach(() => {
  tauriFetch.mockReset();
  __resetScopesForTests();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "u", rememberPassword: false },
      { id: "s2", nickname: "Lab", url: "https://lab.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok1", s2: "tok2" },
  });
});
afterEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
});

const ref = { addr: "sales", conversationId: "c-1", id: "6b1e" };

describe("thread attachment routes", () => {
  it("meta goes to the Thread's own server with that server's token", async () => {
    tauriFetch.mockResolvedValue(res(200, { ok: true, kind: "file", name: "a.pdf", path: "docs/a.pdf", size: 10, state: "changed" }));
    const r = await getAttachmentMeta(scopeFor("s2"), ref, 1);
    expect(r).toEqual({ ok: true, data: expect.objectContaining({ state: "changed", size: 10 }) });
    const [c] = calls();
    expect(c.url.host).toBe("lab.k2.dev");
    expect(c.url.pathname).toBe("/cli/thread/attachment");
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ addr: "sales", id: "6b1e", n: "1", mode: "meta" });
    expect(JSON.stringify(c.headers)).toContain("tok2");
    expect(JSON.stringify(c.headers)).not.toContain("tok1");
    expect((tauriFetch.mock.calls[0][1] as { method?: string }).method).toBe("GET");
  });

  it("maps HTTP errors to typed results", async () => {
    tauriFetch.mockResolvedValueOnce(res(404, { ok: false, error: { code: "attachment_gone" } }));
    expect(await getAttachmentMeta(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "attachment_gone", status: 404 } });
    tauriFetch.mockResolvedValueOnce(res(403, { error: "missing capability files:read" }));
    expect(await getAttachmentMeta(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "missing_capability" } });
    tauriFetch.mockResolvedValueOnce(res(415, { ok: false, error: { code: "no_preview" } }));
    expect(await getAttachmentPreview(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "no_preview" } });
    tauriFetch.mockResolvedValueOnce(res(413, { ok: false, error: { code: "preview_too_large" } }));
    expect(await getAttachmentPreview(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "preview_too_large" } });
    tauriFetch.mockResolvedValueOnce(res(400, { ok: false, error: { code: "usage", hint: "bad n" } }));
    expect(await getAttachmentPreview(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "usage", hint: "bad n" } });
    tauriFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await getAttachmentMeta(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "network" } });
  });

  it("no Thread → usage without a request", async () => {
    expect(await getAttachmentMeta(scopeFor("s1"), { id: "x" }, 0)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(tauriFetch).not.toHaveBeenCalled();
  });
});

describe("downloadAttachment (mode=range)", () => {
  it("4 MB chunks, resumed by offset, stops at eof", async () => {
    const parts = ["hello ", "world"];
    tauriFetch.mockImplementation(async (u: string) => {
      const q = new URL(u).searchParams;
      const offset = Number(q.get("offset"));
      expect(q.get("mode")).toBe("range");
      expect(q.get("len")).toBe(String(4 * 1024 * 1024));
      const i = offset === 0 ? 0 : 1;
      return res(200, { ok: true, base64: b64(parts[i]), len: parts[i].length, offset, size: 11, eof: i === 1 });
    });
    const progress: number[] = [];
    const r = await downloadAttachment(scopeFor("s1"), ref, 0, { onProgress: (d) => progress.push(d) });
    expect(r.ok && new TextDecoder().decode(r.data.bytes)).toBe("hello world");
    expect(calls().map((c) => c.url.searchParams.get("offset"))).toEqual(["0", "6"]);
    expect(progress).toEqual([6, 11]);
  });

  it("a size change between chunks restarts from 0", async () => {
    let n = 0;
    tauriFetch.mockImplementation(async (u: string) => {
      const offset = Number(new URL(u).searchParams.get("offset"));
      n += 1;
      if (n === 1) return res(200, { ok: true, base64: b64("aaa"), len: 3, offset, size: 6, eof: false });
      if (n === 2) return res(200, { ok: true, base64: b64("XX"), len: 2, offset, size: 5, eof: false });
      // The new file, from the top.
      if (offset === 0) return res(200, { ok: true, base64: b64("new"), len: 3, offset, size: 5, eof: false });
      return res(200, { ok: true, base64: b64("er"), len: 2, offset, size: 5, eof: true });
    });
    const r = await downloadAttachment(scopeFor("s1"), ref, 0);
    expect(r.ok && new TextDecoder().decode(r.data.bytes)).toBe("newer");
    expect(calls().map((c) => c.url.searchParams.get("offset"))).toEqual(["0", "3", "0", "3"]);
  });

  it("gives up when the file keeps changing", async () => {
    let size = 10;
    tauriFetch.mockImplementation(async (u: string) => {
      const offset = Number(new URL(u).searchParams.get("offset"));
      size += 1;
      return res(200, { ok: true, base64: b64("ab"), len: 2, offset, size, eof: false });
    });
    const r = await downloadAttachment(scopeFor("s1"), ref, 0);
    expect(r).toMatchObject({ ok: false, error: { code: "changed_during_download" } });
  });

  it("a gone file mid-download is attachment_gone", async () => {
    tauriFetch
      .mockResolvedValueOnce(res(200, { ok: true, base64: b64("ab"), len: 2, offset: 0, size: 4, eof: false }))
      .mockResolvedValueOnce(res(404, { ok: false, error: { code: "attachment_gone" } }));
    expect(await downloadAttachment(scopeFor("s1"), ref, 0)).toMatchObject({ ok: false, error: { code: "attachment_gone" } });
  });
});
