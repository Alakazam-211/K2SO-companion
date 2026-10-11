// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// jsdom cannot run shiki's wasm, pdf.js or mermaid: stand-ins for the
// dynamic imports, so the tests check the wiring, not the libraries.
vi.mock("shiki", () => ({
  bundledLanguages: { json: {}, typescript: {}, rust: {}, markdown: {}, html: {} },
  codeToHtml: vi.fn(async (code: string, o: { lang: string }) =>
    `<pre class="shiki" data-lang="${o.lang}"><code>${code.replace(/</g, "&lt;")}</code></pre>`
  ),
}));
vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn(async () => ({
      value: '<h1>Spec</h1><p onclick="x()">Body<script>bad()</script></p>',
    })),
  },
}));
const pdfMock = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  return {
    page,
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({ numPages: 3, getPage: vi.fn(async () => page), destroy: vi.fn() }),
    })),
    GlobalWorkerOptions: { workerSrc: "" },
  };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfMock.getDocument,
  GlobalWorkerOptions: pdfMock.GlobalWorkerOptions,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mmd-svg"></svg>' })),
  },
}));
vi.mock("../../api/client", () => ({
  getFsReadBinary: vi.fn(),
  getFsReadRange: vi.fn(),
  getFsZipList: vi.fn(),
}));

import { getFsReadBinary, getFsZipList } from "../../api/client";
import FileBody, { TEXT_VIEW_MAX_CHARS } from "./FileBody";
import type { StubFile } from "../stubData";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function text(id: string, body: string): StubFile {
  return { id, name: id.split("/").pop()!, body, loaded: true, fsPath: id, readError: null };
}
function bin(id: string): StubFile {
  return { id, name: id.split("/").pop()!, body: "", loaded: true, fsPath: id, readError: null };
}

beforeEach(() => {
  vi.mocked(getFsReadBinary).mockReset();
  vi.mocked(getFsZipList).mockReset();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => cleanup());

describe("markdown", () => {
  it("renders GFM: headings, tables, task lists, strikethrough", () => {
    const md = "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ **new**\n";
    render(<FileBody file={text("/ws/plan.md", md)} source={false} stub={false} />);
    const root = screen.getByTestId("file-markdown");
    expect(root.className).toContain("markdown-content");
    expect(root.querySelector("h1")?.textContent).toBe("Plan");
    expect(root.querySelectorAll("table td").length).toBe(2);
    expect(root.querySelector("input[type='checkbox']")).not.toBeNull();
    expect(root.querySelector("del")?.textContent).toBe("old");
    expect(root.querySelector("strong")?.textContent).toBe("new");
  });

  it("highlights fenced code through lazy shiki", async () => {
    const md = "```ts\nconst x = 1;\n```\n";
    render(<FileBody file={text("/ws/a.md", md)} source={false} stub={false} />);
    await waitFor(() =>
      expect(document.querySelector("pre.shiki[data-lang='typescript']")?.textContent).toBe("const x = 1;")
    );
    // One <pre>: the fence is not nested in markdown's own.
    expect(document.querySelectorAll("pre").length).toBe(1);
  });

  it("an inline file path opens through onFileLink", () => {
    const onFileLink = vi.fn();
    render(
      <FileBody file={text("/ws/a.md", "see `docs/plan.md`")} source={false} stub={false} onFileLink={onFileLink} />
    );
    screen.getByText("docs/plan.md").click();
    expect(onFileLink).toHaveBeenCalledWith("docs/plan.md");
  });

  it("Source shows the raw markdown", async () => {
    render(<FileBody file={text("/ws/a.md", "# Raw")} source stub={false} />);
    await waitFor(() => expect(screen.getByTestId("file-code").textContent).toContain("# Raw"));
    expect(screen.queryByTestId("file-markdown")).toBeNull();
  });
});

describe("code and JSON", () => {
  it("pretty-prints and highlights JSON", async () => {
    render(<FileBody file={text("/ws/p.json", '{"a":1,"b":[2]}')} source={false} stub={false} />);
    await waitFor(() => expect(document.querySelector("pre.shiki[data-lang='json']")).not.toBeNull());
    expect(screen.getByTestId("file-code").textContent).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it("code shows plain text first, then the highlight; no wrap", async () => {
    render(<FileBody file={text("/ws/main.rs", "fn main() {}")} source={false} stub={false} />);
    expect(screen.getByTestId("file-code").textContent).toBe("fn main() {}");
    expect(screen.getByTestId("file-code").className).not.toContain("fv-code-wrap");
    await waitFor(() => expect(document.querySelector("pre.shiki[data-lang='rust']")).not.toBeNull());
  });

  it("plain text with no grammar wraps and stays plain", () => {
    render(<FileBody file={text("/ws/notes.txt", "hello")} source={false} stub={false} />);
    expect(screen.getByTestId("file-code").className).toContain("fv-code-wrap");
  });

  it("very large text is cut with a note", () => {
    const big = "x".repeat(TEXT_VIEW_MAX_CHARS + 10);
    render(<FileBody file={text("/ws/big.txt", big)} source={false} stub={false} />);
    expect(screen.getByTestId("file-truncated").textContent).toMatch(/Showing the first/);
    expect(screen.getByTestId("file-code").textContent!.length).toBe(TEXT_VIEW_MAX_CHARS);
  });
});

describe("binary empty state", () => {
  it("a binary extension never loads bytes", () => {
    render(<FileBody file={bin("/ws/app.wasm")} source={false} stub={false} />);
    expect(screen.getByTestId("file-binary").textContent).toContain("Binary file");
    expect(screen.getByTestId("file-binary").textContent).toContain("app.wasm");
    expect(getFsReadBinary).not.toHaveBeenCalled();
  });

  it("read-file's binary refusal shows the empty state, not an error dump", () => {
    const f = { ...text("/ws/blob.txt", ""), readError: "Cannot read binary file" };
    render(<FileBody file={f} source={false} stub={false} />);
    expect(screen.getByTestId("file-binary")).toBeTruthy();
  });

  it("other read errors show the message", () => {
    const f = { ...text("/ws/huge.log", ""), readError: "File too large (>10MB)" };
    render(<FileBody file={f} source={false} stub={false} />);
    expect(screen.getByTestId("file-error").textContent).toContain("File too large");
  });
});

describe("byte viewers", () => {
  it("image: read-binary → sniffed Blob URL in an <img>", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: true, data: { base64: b64(PNG) } });
    render(<FileBody file={bin("/ws/shot.jpg")} source={false} stub={false} />);
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("blob:mock");
    expect(getFsReadBinary).toHaveBeenCalledWith(expect.anything(), "/ws/shot.jpg");
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    // Sniffed PNG beats the .jpg name.
    expect(blob.type).toBe("image/png");
  });

  it("image read failure shows the error", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: false, error: "File not found" });
    render(<FileBody file={bin("/ws/gone.png")} source={false} stub={false} />);
    expect(await screen.findByText("File not found")).toBeTruthy();
  });

  it("PDF: loads pdf.js (legacy build) with the worker URL and lays out every page", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: true, data: { base64: b64([0x25, 0x50, 0x44, 0x46]) } });
    render(<FileBody file={bin("/ws/brief.pdf")} source={false} stub={false} />);
    await screen.findByTestId("file-pdf");
    expect(pdfMock.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.min.mjs");
    expect(pdfMock.getDocument).toHaveBeenCalledWith(expect.objectContaining({ isEvalSupported: false }));
    expect(await screen.findByText("3 pages")).toBeTruthy();
  });

  it("DOCX: mammoth output is sanitized", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: true, data: { base64: b64([0x50, 0x4b, 3, 4]) } });
    render(<FileBody file={bin("/ws/spec.docx")} source={false} stub={false} />);
    const doc = await screen.findByTestId("file-docx");
    expect(doc.querySelector("h1")?.textContent).toBe("Spec");
    expect(doc.innerHTML).not.toMatch(/script|onclick/);
  });

  it("ZIP: lists central-directory entries", async () => {
    vi.mocked(getFsZipList).mockResolvedValue({
      ok: true,
      data: {
        entries: [
          { name: "app.md", size: 3420, is_dir: false },
          { name: "tables/", size: 0, is_dir: true },
        ],
        truncated: false,
      },
    });
    render(<FileBody file={bin("/ws/x.zip")} source={false} stub={false} />);
    const list = await screen.findByTestId("file-zip");
    expect(list.textContent).toContain("app.md");
    expect(list.textContent).toContain("3.3 KB");
    expect(list.textContent).toContain("folder");
    expect(getFsReadBinary).not.toHaveBeenCalled();
  });

  it("video: Blob URL in a playsInline <video controls>", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: true, data: { base64: b64([0, 0, 0, 0x18]) } });
    render(<FileBody file={bin("/ws/clip.mp4")} source={false} stub={false} />);
    await screen.findByTestId("file-media");
    const v = document.querySelector("video")!;
    expect(v.getAttribute("src")).toBe("blob:mock");
    expect(v.hasAttribute("controls")).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
  });
});

describe("HTML and diagrams", () => {
  it("HTML renders in a script-less sandboxed frame with a CSP", () => {
    render(<FileBody file={text("/ws/i.html", "<p>hi</p><script>x()</script>")} source={false} stub={false} />);
    const frame = screen.getByTestId("file-html") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("Mermaid renders its SVG", async () => {
    render(<FileBody file={text("/ws/f.mmd", "graph TD; A-->B")} source={false} stub={false} />);
    expect(await screen.findByTestId("mmd-svg")).toBeTruthy();
  });

  it("Graphviz shows a note and the source", () => {
    render(<FileBody file={text("/ws/g.dot", "digraph { a -> b }")} source={false} stub={false} />);
    expect(screen.getByTestId("file-diagram-source").textContent).toContain("Graphviz DOT source");
    expect(screen.getByTestId("file-code").textContent).toBe("digraph { a -> b }");
  });
});
