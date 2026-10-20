// @vitest-environment jsdom
// Thread images (K2 0.46.3 `thread-images-v1`) against a fake daemon.
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
import { ThreadPane } from "./ThreadPane";
import { __resetThumbLoadsForTests, fitImage } from "./ThreadImages";
import { __resetThumbCacheForTests, thumbCache } from "./thumbCache";
import { normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { useRoomServer } from "./zenScope";
import { useZenStore } from "./zenStore";

// Thread images (K2 0.46.3 `thread-images-v1`): thumbnails inline, the
// gate, the chip fallback, and the device cache key.

const PNG_B64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

type Q = Record<string, string>;

function daemon(onAttachment: (q: Q) => ReturnType<typeof res>) {
  tauriFetch.mockImplementation(async (u: string) => {
    const url = new URL(u);
    if (url.pathname === "/cli/thread/attachment") return onAttachment(Object.fromEntries(url.searchParams));
    return res(404, { error: "route_unclassified" });
  });
}

const modes = () =>
  tauriFetch.mock.calls
    .map(([u]) => new URL(u as string))
    .filter((u) => u.pathname === "/cli/thread/attachment")
    .map((u) => u.searchParams.get("mode"));

function image(over: Record<string, unknown> = {}) {
  return {
    kind: "file",
    state: "ok",
    path: "shots/home.png",
    name: "home.png",
    size: 81234,
    mime: "image/png",
    modifiedAt: 1760790000000,
    sha256: "aa",
    ...over,
  };
}

const thumb = (over: Record<string, unknown> = {}) =>
  res(200, {
    ok: true,
    kind: "image",
    mime: "image/jpeg",
    width: 512,
    height: 384,
    px: 512,
    base64: PNG_B64,
    name: "home.png",
    size: 81234,
    state: "ok",
    ...over,
  });

function message(id: string, body: string, attachments: unknown[]): ThreadMessage {
  return normaliseThreadItem({ doc: { id, seq: 1, kind: "text", from: "sales", body, created_at: 1760790000, attachments } }, "me")!;
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
  __resetScopesForTests();
  __resetThumbCacheForTests();
  __resetThumbLoadsForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "me", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok1" },
  });
  noteBootStatus("s1", { version: "0.46.3", features: ["thread-attachments-v1", "thread-images-v1"] });
  daemon(() => thumb());
});

afterEach(() => {
  cleanup();
  useRoomServer.setState({ serverId: null });
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
  useZenStore.setState({ thread: [], threadAddr: null, threadConversationId: null, agentId: "", agents: [], outbox: [] });
});

describe("thread images", () => {
  it("an image draws as a thumbnail (mode=thumb, px=512) at its own shape; other files stay chips", async () => {
    room([message("m1", "here", [image(), { ...image(), path: "docs/a.pdf", name: "a.pdf", mime: "application/pdf" }])]);
    render(<ThreadPane />);
    const tile = await screen.findByTestId("thread-image");
    await waitFor(() => expect(tile.getAttribute("data-loaded")).toBe("true"));
    const img = within(tile).getByTestId("thread-image-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`data:image/jpeg;base64,${PNG_B64}`);
    expect(tile.style.width).toBe("220px");
    expect(tile.style.height).toBe("165px");
    const call = tauriFetch.mock.calls.map(([u]) => new URL(u as string)).find((u) => u.searchParams.get("mode") === "thumb")!;
    expect(Object.fromEntries(call.searchParams)).toMatchObject({ addr: "sales", id: "m1", n: "0", px: "512" });
    expect(screen.getAllByTestId("thread-file")).toHaveLength(1);
  });

  it("without thread-images-v1 an image stays a chip and nothing is fetched", async () => {
    noteBootStatus("s1", { version: "0.46.1", features: ["thread-attachments-v1"] });
    room([message("m1", "here", [image()])]);
    render(<ThreadPane />);
    expect(await screen.findByTestId("thread-file")).toBeTruthy();
    expect(screen.queryByTestId("thread-image")).toBeNull();
    expect(modes()).toEqual([]);
  });

  it("415 no_thumbnail (HEIC with no converter) falls back to the chip", async () => {
    daemon(() => res(415, { ok: false, error: { code: "no_thumbnail", hint: "no converter" } }));
    room([message("m1", "", [image({ path: "IMG_1.heic", name: "IMG_1.heic", mime: "image/heic" })])]);
    render(<ThreadPane />);
    await screen.findByTestId("thread-image");
    await waitFor(() => expect(screen.queryByTestId("thread-image")).toBeNull());
    expect(screen.getByTestId("thread-file").getAttribute("aria-label")).toContain("IMG_1.heic");
  });

  it("two or more images: a grid of square tiles", async () => {
    room([message("m1", "", [image(), image({ path: "shots/b.png", name: "b.png" })])]);
    render(<ThreadPane />);
    const tiles = await screen.findAllByTestId("thread-image");
    expect(tiles).toHaveLength(2);
    expect(tiles[0].style.width).toBe("108px");
    expect(tiles[0].style.height).toBe("108px");
  });

  it("a cached thumb draws at once and is not fetched again", async () => {
    room([message("m1", "", [image()])]);
    const first = render(<ThreadPane />);
    await waitFor(() => expect(screen.getByTestId("thread-image").getAttribute("data-loaded")).toBe("true"));
    expect(modes()).toEqual(["thumb"]);
    first.unmount();
    __resetThumbLoadsForTests();
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-image").getAttribute("data-loaded")).toBe("true");
    expect(modes()).toEqual(["thumb"]);
  });

  it("changed: asks meta for the live version and keys the cache on it", async () => {
    daemon((q) =>
      q.mode === "meta"
        ? res(200, { kind: "file", name: "home.png", path: "shots/home.png", size: 99000, mime: "image/png", modifiedAt: 1760800000000, state: "changed" })
        : thumb({ state: "changed" })
    );
    room([message("m1", "", [image({ state: "changed" })])]);
    render(<ThreadPane />);
    await waitFor(() => expect(screen.getByTestId("thread-image").getAttribute("data-loaded")).toBe("true"));
    expect(modes()).toEqual(["meta", "thumb"]);
    expect(screen.getByTestId("thread-image-changed")).toBeTruthy();
    expect(thumbCache().peek("s1|512|1760800000000|99000|shots/home.png")).not.toBeNull();
  });

  it("a tap opens the attachment sheet (preview)", async () => {
    room([message("m1", "", [image()])]);
    render(<ThreadPane />);
    const tile = await screen.findByTestId("thread-image");
    await act(async () => {
      fireEvent.click(tile);
    });
    await waitFor(() => expect(modes()).toContain("meta"));
  });

  it("fitImage keeps the shape inside 220×260 and never below 48", () => {
    expect(fitImage(512, 384)).toEqual({ w: 220, h: 165 });
    expect(fitImage(384, 512)).toEqual({ w: 195, h: 260 });
    expect(fitImage(4000, 100)).toEqual({ w: 220, h: 48 });
    expect(fitImage(0, 0)).toEqual({ w: 200, h: 150 });
  });
});
