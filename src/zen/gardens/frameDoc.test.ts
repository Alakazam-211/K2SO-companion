import { describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ lib: vi.fn(), fetch: vi.fn() }));
vi.mock("./gardensApi", () => ({ fetchGardenLibFile: net.lib, requestGardenLib: net.fetch }));

import { buildFrameDoc, escapeForScript, fileChecks, fillSlots, forgetGardenLibs, integrityChecks } from "./frameDoc";
import type { GardenFrameBody } from "./gardensApi";

// sha256("hello") and sha384("hello") from a reference tool.
const HELLO_256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_384_B64 = "WeF0h3dEjGnea4ANejO7+5/xtGPkQ1TDVTvNucZm+pASWjx5+QOXvfX2oT3oKGhP";

const scope = {} as never;
const frame = (over: Partial<GardenFrameBody>): GardenFrameBody => ({
  garden: "g",
  placement: "p",
  widget: "w",
  hash: "h",
  nonce: "n",
  srcdoc: "<script nonce=n>__K2_LIB_0__</script>",
  libs: [],
  hello: {},
  ...over,
});
const lib = {
  slot: "__K2_LIB_0__",
  key: "x@1",
  id: "x",
  version: "1",
  source: "bundled" as const,
  files: [{ name: "x.js", sha256: HELLO_256, bytes: 5 }],
};

describe("a widget's document (Gardens contract §4.2)", () => {
  it("checks bytes and sha256, and a CDN file's integrity", () => {
    expect(fileChecks("hello", { bytes: 5, sha256: HELLO_256 })).toBe(true);
    expect(fileChecks("hello", { bytes: 6, sha256: HELLO_256 })).toBe(false);
    expect(fileChecks("hellO", { bytes: 5, sha256: HELLO_256 })).toBe(false);
    expect(integrityChecks("hello", `sha384-${HELLO_384_B64}`)).toBe(true);
    expect(integrityChecks("hellO", `sha384-${HELLO_384_B64}`)).toBe(false);
    expect(integrityChecks("hello", "md5-xx")).toBe(false);
  });

  it("escapes </script in any case and changes nothing else", () => {
    expect(escapeForScript("a</script>b</SCRIPT>c<script>$&")).toBe("a<\\/script>b<\\/SCRIPT>c<script>$&");
  });

  it("fills in one pass: a library that mentions a later slot stays as written", () => {
    const out = fillSlots(
      "__K2_LIB_0__|__K2_LIB_1__|__K2_LIB_9__",
      new Map([
        ["__K2_LIB_0__", "uses __K2_LIB_1__ and $1"],
        ["__K2_LIB_1__", "two"],
      ])
    );
    expect(out).toBe("uses __K2_LIB_1__ and $1|two|__K2_LIB_9__");
  });

  it("joins a library's files with \\n;\\n", async () => {
    forgetGardenLibs();
    net.lib.mockReset().mockResolvedValue({ ok: true, data: "hello" });
    const two = { ...lib, files: [lib.files[0], { name: "y.js", sha256: HELLO_256, bytes: 5 }] };
    const r = await buildFrameDoc(scope, frame({ libs: [two] }));
    expect(r).toEqual({ ok: true, data: "<script nonce=n>hello\n;\nhello</script>" });
  });

  it("fails closed when a file doesn't check", async () => {
    forgetGardenLibs();
    net.lib.mockReset().mockResolvedValue({ ok: true, data: "tampered" });
    const r = await buildFrameDoc(scope, frame({ libs: [lib] }));
    expect(r).toMatchObject({ ok: false, refusal: { code: "lib_mismatch" } });
  });

  it("asks once for a download the server doesn't hold, then reads again", async () => {
    forgetGardenLibs();
    net.fetch.mockReset().mockResolvedValue({ ok: true, data: {} });
    net.lib
      .mockReset()
      .mockResolvedValueOnce({ ok: false, refusal: { status: 404, code: "not_cached", hint: "" } })
      .mockResolvedValueOnce({ ok: true, data: "hello" });
    const r = await buildFrameDoc(scope, frame({ libs: [{ ...lib, source: "download" }] }));
    expect(r.ok).toBe(true);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(net.fetch.mock.calls[0][1]).toEqual({ id: "x", version: "1" });
  });
});
