// @vitest-environment jsdom
// Thread files (K2 0.46.1 `thread-attachments-v1`): chips under bubbles,
// the gate, and the open flow against a fake daemon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
// shiki in jsdom: one `.line` span per line, like the real output.
vi.mock("shiki", () => ({
  bundledLanguages: { rust: {}, markdown: {} },
  codeToHtml: vi.fn(async (code: string, o: { lang: string }) =>
    `<pre class="shiki" data-lang="${o.lang}"><code>${code
      .split("\n")
      .map((l) => `<span class="line">${l.replace(/</g, "&lt;")}</span>`)
      .join("\n")}</code></pre>`
  ),
}));
const pdfMock = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  return {
    getDocument: vi.fn((_: { data: Uint8Array }) => ({
      promise: Promise.resolve({ numPages: 2, getPage: vi.fn(async () => page), destroy: vi.fn() }),
    })),
    GlobalWorkerOptions: { workerSrc: "" },
  };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfMock.getDocument,
  GlobalWorkerOptions: pdfMock.GlobalWorkerOptions,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));
vi.mock("./files/shareFile", () => ({ shareOrSaveBytes: vi.fn(async () => "shared") }));

import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { shareOrSaveBytes } from "./files/shareFile";
import { ThreadPane } from "./ThreadPane";
import { GONE_TEXT, HIDDEN_TEXT } from "./ThreadFiles";
import { normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { useRoomServer } from "./zenScope";
import { useZenStore } from "./zenStore";

const FEATURE = "thread-attachments-v1";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const b64 = (bytes: number[] | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes));

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

type Q = Record<string, string>;
type AttachmentHandler = (q: Q, host: string) => ReturnType<typeof res>;

/** The fake daemon: `/cli/thread/attachment` by handler, 404 otherwise. */
function daemon(onAttachment: AttachmentHandler) {
  tauriFetch.mockImplementation(async (u: string) => {
    const url = new URL(u);
    if (url.pathname === "/cli/thread/attachment") {
      return onAttachment(Object.fromEntries(url.searchParams), url.host);
    }
    return res(404, { error: "route_unclassified" });
  });
}

const attachmentCalls = () =>
  tauriFetch.mock.calls
    .map(([u, init]) => ({ url: new URL(u as string), init: init as { headers?: unknown } }))
    .filter((c) => c.url.pathname === "/cli/thread/attachment");

function file(over: Record<string, unknown> = {}) {
  return {
    kind: "file",
    state: "ok",
    path: "docs/report-q3.pdf",
    name: "report-q3.pdf",
    size: 245812,
    mime: "application/pdf",
    modifiedAt: 1760790000000,
    sha256: "9f2c",
    ...over,
  };
}

function message(id: string, seq: number, body: string, attachments: unknown[], from = "sales"): ThreadMessage {
  return normaliseThreadItem({ doc: { id, seq, kind: "text", from, body, created_at: 1760790000, attachments } }, "me")!;
}

function room(thread: ThreadMessage[]) {
  useZenStore.setState({
    threadSource: "live",
    threadError: null,
    sendError: null,
    sending: false,
    thread,
    threadAddr: "sales",
    threadConversationId: "c-1",
    threadGroupId: null,
    agentId: "a1",
    agents: [{ id: "a1", name: "Sales", initial: "S", addr: "sales" }],
    outbox: [],
  });
}

beforeEach(() => {
  tauriFetch.mockReset();
  vi.mocked(shareOrSaveBytes).mockClear();
  pdfMock.getDocument.mockClear();
  __resetScopesForTests();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "me", rememberPassword: false },
      { id: "s2", nickname: "Lab", url: "https://lab.k2.dev", username: "me", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok1", s2: "tok2" },
  });
  noteBootStatus("s1", { version: "0.46.1", features: [FEATURE] });
  daemon(() => res(404, { ok: false, error: { code: "not_found" } }));
});

afterEach(() => {
  cleanup();
  useRoomServer.setState({ serverId: null });
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
  useZenStore.setState({ thread: [], threadAddr: null, threadConversationId: null, agentId: "", agents: [], outbox: [] });
});

describe("gate", () => {
  it("without thread-attachments-v1: no chips, a files-only message draws nothing", () => {
    noteBootStatus("s1", { version: "0.46.0", features: ["thread-latest"] });
    room([message("m1", 1, "The Q3 report is ready", [file()]), message("m2", 2, "", [file()])]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("thread-files")).toBeNull();
    expect(screen.getAllByTestId("thread-bubble")).toHaveLength(1);
    expect(document.querySelectorAll("[data-thread-msg]")).toHaveLength(1);
  });

  it("an unknown server (no boot-status yet) shows nothing new", () => {
    __resetScopesForTests();
    room([message("m1", 1, "hi", [file()])]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("thread-files")).toBeNull();
  });

  it("with the feature: chips under the bubble", () => {
    room([message("m1", 1, "The Q3 report is ready", [file()])]);
    render(<ThreadPane />);
    const chip = screen.getByTestId("thread-file");
    expect(chip.tagName).toBe("BUTTON");
    expect(within(chip).getByTestId("thread-file-name").getAttribute("data-full")).toBe("report-q3.pdf");
    expect(within(chip).getByTestId("thread-file-sub").textContent).toBe("240 KB");
  });
});

describe("chips", () => {
  it("each state: ok, changed, gone, hidden", () => {
    room([
      message("m1", 1, "two", [file(), file({ state: "changed", name: "session.rs", path: "src/session.rs", mime: "text/plain", size: 9000 })]),
      message("m2", 2, "two more", [file({ state: "gone", name: "old.txt", path: "old.txt" }), { kind: "file", state: "hidden" }]),
    ]);
    render(<ThreadPane />);
    const chips = screen.getAllByTestId("thread-file");
    expect(chips.map((c) => c.getAttribute("data-state"))).toEqual(["ok", "changed", "gone", "hidden"]);
    const [, changed, gone, hidden] = chips;
    expect(changed.tagName).toBe("BUTTON");
    expect(within(changed).getByTestId("thread-file-changed-dot")).toBeTruthy();
    expect(changed.textContent).toContain("changed since sent");
    expect(gone.tagName).toBe("DIV");
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    expect((within(gone).getByTestId("thread-file-name") as HTMLElement).style.textDecoration).toBe("line-through");
    expect(gone.textContent).toContain(GONE_TEXT);
    expect(hidden.tagName).toBe("DIV");
    expect(hidden.textContent).toBe(HIDDEN_TEXT);
    // Tapping a gone or hidden chip asks nothing.
    fireEvent.click(gone);
    fireEvent.click(hidden);
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
  });

  it("an unknown kind is a plain card that never opens", () => {
    room([message("m1", 1, "x", [file({ kind: "folder", name: "docs", path: "docs" })])]);
    render(<ThreadPane />);
    const chip = screen.getByTestId("thread-file");
    expect(chip.tagName).toBe("DIV");
    expect(chip.getAttribute("data-kind")).toBe("folder");
  });

  it("3+ files: one list card, five rows, the rest behind Show N more", () => {
    const seven = Array.from({ length: 7 }, (_, i) => file({ name: `f${i}.txt`, path: `f${i}.txt` }));
    room([message("m1", 1, "lots", seven), message("m2", 2, "three", seven.slice(0, 3))]);
    render(<ThreadPane />);
    const [big, small] = screen.getAllByTestId("thread-files-card");
    expect(within(big).getByTestId("thread-files-count").textContent).toBe("7 files");
    expect(within(big).getAllByTestId("thread-file")).toHaveLength(5);
    fireEvent.click(within(big).getByTestId("thread-files-more"));
    expect(within(big).getAllByTestId("thread-file")).toHaveLength(7);
    expect(within(small).getByTestId("thread-files-count").textContent).toBe("3 files");
    expect(within(small).queryByTestId("thread-files-more")).toBeNull();
  });

  it("an empty body draws the chips with no bubble", () => {
    room([message("m1", 1, "", [file({ name: "shot.png", path: "out/shot.png", mime: "image/png" })])]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("thread-bubble")).toBeNull();
    expect(screen.getByTestId("thread-file")).toBeTruthy();
  });

  it("chips sit on their bubble's side", () => {
    room([message("mine1", 1, "from me", [file()], "owner"), message("theirs1", 2, "from them", [file()])]);
    render(<ThreadPane />);
    const [mine, theirs] = screen.getAllByTestId("thread-files");
    expect(mine.getAttribute("data-side")).toBe("mine");
    expect(mine.className).toContain("items-end");
    expect(mine.closest("[data-thread-msg]")!.className).toContain("self-end");
    expect(theirs.getAttribute("data-side")).toBe("theirs");
    expect(theirs.className).toContain("items-start");
  });
});

describe("open", () => {
  const meta = (over: Record<string, unknown> = {}) =>
    res(200, { ok: true, kind: "file", name: "x", path: "x", size: 100, mime: "", modifiedAt: 1, state: "ok", ...over });

  it("text: preview, truncated note, jumps to line..lineEnd", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    daemon((q) =>
      q.mode === "meta"
        ? meta({ state: "changed", size: 9120 })
        : res(200, { ok: true, kind: "text", mime: "text/plain", name: "session.rs", size: 9120, state: "changed", text, truncated: true })
    );
    room([
      message("m1", 1, "see", [file({ state: "ok", name: "session.rs", path: "src/session.rs", mime: "text/plain", line: 12, lineEnd: 14 })]),
    ]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect(await screen.findByTestId("attachment-sheet")).toBeTruthy();
    expect(await screen.findByTestId("attachment-truncated")).toBeTruthy();
    await waitFor(() => expect(document.querySelector("pre.shiki[data-lang='rust']")).not.toBeNull());
    await waitFor(() => {
      const hl = Array.from(document.querySelectorAll("[data-hl='true']")).map((e) => e.textContent);
      expect(hl).toEqual(["line 12", "line 13", "line 14"]);
    });
    // The fresh state reached the header and the chip.
    expect(screen.getByTestId("attachment-changed")).toBeTruthy();
    expect(screen.getAllByTestId("thread-file")[0].getAttribute("data-state")).toBe("changed");
    const qs = attachmentCalls().map((c) => Object.fromEntries(c.url.searchParams));
    expect(qs).toEqual([
      { addr: "sales", id: "m1", n: "0", mode: "meta" },
      { addr: "sales", id: "m1", n: "0", mode: "preview" },
    ]);
  });

  it("image: preview bytes paint in the file viewer's ImageView", async () => {
    daemon((q) =>
      q.mode === "meta"
        ? meta({ mime: "image/png" })
        : res(200, { ok: true, kind: "image", mime: "image/png", name: "shot.png", size: 8, state: "ok", base64: b64(PNG) })
    );
    room([message("m1", 1, "", [file({ name: "shot.png", path: "out/shot.png", mime: "image/png" })])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    const img = await screen.findByTestId("file-image");
    expect(img.querySelector("img")?.getAttribute("src")).toBe("blob:mock");
    expect(screen.getByTestId("attachment-share")).toBeTruthy();
    // Never read as a workspace file.
    expect(tauriFetch.mock.calls.some(([u]) => /\/cli\/fs\//.test(String(u)))).toBe(false);
  });

  it("pdf: preview bytes go to PdfView", async () => {
    const pdfBytes = "%PDF-1.4 fake";
    daemon((q) =>
      q.mode === "meta"
        ? meta({ mime: "application/pdf" })
        : res(200, { ok: true, kind: "pdf", mime: "application/pdf", name: "report-q3.pdf", size: 13, state: "ok", base64: b64(pdfBytes) })
    );
    room([message("m1", 1, "report", [file()])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect(await screen.findByTestId("file-pdf")).toBeTruthy();
    const data = pdfMock.getDocument.mock.calls[0][0].data;
    expect(new TextDecoder().decode(data)).toBe(pdfBytes);
  });

  it("413 → mode=range chunks into the viewer", async () => {
    const parts = [PNG.slice(0, 4), PNG.slice(4)];
    daemon((q) => {
      if (q.mode === "meta") return meta({ size: 8, mime: "image/png" });
      if (q.mode === "preview") return res(413, { ok: false, error: { code: "preview_too_large" } });
      const i = q.offset === "0" ? 0 : 1;
      return res(200, { ok: true, base64: b64(parts[i]), len: 4, offset: Number(q.offset), size: 8, eof: i === 1 });
    });
    room([message("m1", 1, "", [file({ name: "huge.png", path: "huge.png", mime: "image/png" })])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect(await screen.findByTestId("file-image")).toBeTruthy();
    const ranges = attachmentCalls().filter((c) => c.url.searchParams.get("mode") === "range");
    expect(ranges.map((c) => c.url.searchParams.get("offset"))).toEqual(["0", "4"]);
  });

  it("415 → a file card; Download pulls mode=range and hands it to Share", async () => {
    daemon((q) => {
      if (q.mode === "meta") return meta({ size: 5, mime: "application/octet-stream" });
      if (q.mode === "preview") return res(415, { ok: false, error: { code: "no_preview" } });
      return res(200, { ok: true, base64: b64("hello"), len: 5, offset: 0, size: 5, eof: true });
    });
    room([message("m1", 1, "build", [file({ name: "app.bin", path: "out/app.bin", mime: "application/octet-stream", size: 5 })])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    const card = await screen.findByTestId("attachment-card");
    expect(card.textContent).toContain("app.bin · 5 B");
    expect(attachmentCalls().some((c) => c.url.searchParams.get("mode") === "range")).toBe(false);
    fireEvent.click(within(card).getByTestId("attachment-download"));
    await waitFor(() => expect(shareOrSaveBytes).toHaveBeenCalledTimes(1));
    const [bytes, name] = vi.mocked(shareOrSaveBytes).mock.calls[0];
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(name).toBe("app.bin");
  });

  it("above 25 MB a download asks first", async () => {
    const big = 30 * 1024 * 1024;
    daemon((q) => {
      if (q.mode === "meta") return meta({ size: big, mime: "application/pdf" });
      if (q.mode === "preview") return res(413, { ok: false, error: { code: "preview_too_large" } });
      return res(200, { ok: true, base64: b64("%PDF"), len: 4, offset: 0, size: 4, eof: true });
    });
    room([message("m1", 1, "big", [file({ size: big })])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    const ask = await screen.findByTestId("attachment-confirm");
    expect(ask.textContent).toContain("30.0 MB");
    expect(attachmentCalls().some((c) => c.url.searchParams.get("mode") === "range")).toBe(false);
    fireEvent.click(within(ask).getByTestId("attachment-confirm-download"));
    expect(await screen.findByTestId("file-pdf")).toBeTruthy();
  });

  it("meta says gone: the note, and the chip turns gone", async () => {
    daemon(() => meta({ state: "gone" }));
    room([message("m1", 1, "see", [file()])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect((await screen.findByTestId("attachment-gone")).textContent).toContain(GONE_TEXT);
    expect(attachmentCalls()).toHaveLength(1);
    fireEvent.click(screen.getByTestId("attachment-close"));
    const chip = screen.getByTestId("thread-file");
    expect(chip.getAttribute("data-state")).toBe("gone");
    expect(chip.tagName).toBe("DIV");
  });

  it("404 attachment_gone reads the same", async () => {
    daemon(() => res(404, { ok: false, error: { code: "attachment_gone" } }));
    room([message("m1", 1, "see", [file()])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect(await screen.findByTestId("attachment-gone")).toBeTruthy();
    expect(useZenStore.getState().thread[0].files![0].state).toBe("gone");
  });

  it("a guest without file rights: the not-shared note, the chip unchanged", async () => {
    daemon(() => res(403, { error: "missing capability files:read" }));
    room([message("m1", 1, "see", [file()])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    expect((await screen.findByTestId("attachment-error")).textContent).toMatch(/isn't shared with you/);
    expect(useZenStore.getState().thread[0].files![0].state).toBe("ok");
  });

  it("a room on another server opens through that server and its login", async () => {
    noteBootStatus("s2", { version: "0.46.1", features: [FEATURE] });
    act(() => useRoomServer.setState({ serverId: "s2" }));
    daemon((q, host) =>
      q.mode === "meta"
        ? meta({ size: 5 })
        : res(200, { ok: true, kind: "text", mime: "text/plain", name: "a.txt", size: 5, state: "ok", text: host, truncated: false })
    );
    room([message("m1", 1, "see", [file({ name: "a.txt", path: "a.txt", mime: "text/plain" })])]);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-file"));
    await waitFor(() => expect(screen.getByTestId("file-code").textContent).toBe("lab.k2.dev"));
    expect(screen.getByTestId("attachment-sheet").getAttribute("data-scope")).toBe("s2");
    for (const c of attachmentCalls()) {
      expect(c.url.host).toBe("lab.k2.dev");
      expect(JSON.stringify(c.init.headers)).toContain("tok2");
    }
  });

  it("a remote server without the feature shows no chips even when the active one has it", () => {
    noteBootStatus("s2", { version: "0.46.0", features: [] });
    act(() => useRoomServer.setState({ serverId: "s2" }));
    room([message("m1", 1, "see", [file()])]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("thread-files")).toBeNull();
  });
});
