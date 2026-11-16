import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Node's modules by name: the app's tsconfig has no Node types (DOM only).
type Any = any;
const load = (m: string): Promise<Any> => import(/* @vite-ignore */ m);
let cp: Any, fs: Any, os: Any, path: Any;
beforeAll(async () => {
  [cp, fs, os, path] = await Promise.all(["node:child_process", "node:fs", "node:os", "node:path"].map(load));
  const url: Any = await load("node:url");
  ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
  SCRIPT = path.join(ROOT, "scripts/fetch-dfn3.sh");
  DFN3 = path.join(ROOT, "src-tauri/resources/dfn3");
});

// scripts/fetch-dfn3.sh: noise removal's DeepFilterNet3 weights, fetched
// from Sew's release and checked against pinned sha256s. release.sh runs it
// before the build and `--verify` on the archived app; any mismatch fails.

let ROOT = "";
let SCRIPT = "";
let DFN3 = "";
const TEXTS = ["NOTICE", "LICENSE-MIT", "LICENSE-APACHE"];

const run = (args: string[], env: Record<string, string> = {}): { status: number | null; stderr: string } =>
  cp.spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...(globalThis as Any).process.env, ...env } });
const join = (...p: string[]): string => path.join(...p);

const dirs: string[] = [];
const temp = (): string => {
  const d: string = fs.mkdtempSync(join(os.tmpdir(), "dfn3-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("scripts/fetch-dfn3.sh", () => {
  it("pins Sew 0.10.2's asset (size and sha256) and the weights' sha256", () => {
    const s = fs.readFileSync(SCRIPT, "utf8");
    expect(s).toContain('ASSET_SHA256="153721fd5f9f33663da7d831b3b611adcb9ca9e65233a6128d94941ad48d6697"');
    expect(s).toContain("ASSET_SIZE=36353582");
    expect(s).toContain('"$WEIGHTS b6e52c0bc66b82e42e3403d22cdd3b847143026d6a41cc4380a97b044f7766af"');
    expect(s).toContain("releases/download/v${SEW_VERSION}/${ASSET}");
  });

  it("--verify fails when a file is missing", () => {
    const d = temp();
    for (const f of TEXTS) fs.copyFileSync(join(DFN3, f), join(d, f));
    const r = run(["--verify", d]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("missing");
  });

  it("--verify fails on a sha256 mismatch", () => {
    const d = temp();
    for (const f of TEXTS) fs.copyFileSync(join(DFN3, f), join(d, f));
    fs.writeFileSync(join(d, "dfn3_ll.nnef.tar"), "not the weights");
    const r = run(["--verify", d]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("sha256 mismatch");
  });

  it("refuses a tarball that isn't Sew's asset, and installs nothing", () => {
    const d = temp();
    const bogus = join(d, "sew-dfn3-0.10.2.tar.gz");
    fs.writeFileSync(bogus, "tampered");
    const before = fs.existsSync(join(DFN3, "dfn3_ll.nnef.tar")) ? fs.readFileSync(join(DFN3, "NOTICE")) : null;
    const r = run(["--force"], { DFN3_TARBALL: bogus });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/bytes, expected 36353582|sha256 mismatch/);
    if (before) expect(fs.readFileSync(join(DFN3, "NOTICE"))).toEqual(before);
  });

  it("--verify passes on the fetched files (where they were fetched)", ({ skip }) => {
    if (!fs.existsSync(join(DFN3, "dfn3_ll.nnef.tar"))) skip();
    const r = run(["--verify", DFN3]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
