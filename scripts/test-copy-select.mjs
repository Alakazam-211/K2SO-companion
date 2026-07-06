// T6 pure tests: touch selection geometry (lib/touchSelect.ts) +
// selection → clipboard text extraction (lib/copyText.ts, desktop
// copyText.ts port) — normalization, highlight segments, absolute
// cell hit-testing, cluster math for wide/zero-width runs, and the
// trailing-trim / newline / soft-wrap-join assembly semantics.
//
// touchSelect.ts is import-free and loads directly; copyText.ts
// imports api/gridConvert (extensionless, bundler-resolved), so it's
// bundled on the fly with esbuild — the test-terminal-render.mjs
// idiom.
//
// Run:  node scripts/test-copy-select.mjs

import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  normalizeSelection,
  selectionRowSegments,
  absCellFromPoint,
} from "../src/lib/touchSelect.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, ".t6-copy.bundle.mjs");

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

await build({
  entryPoints: [path.join(here, "../src/lib/copyText.ts")],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "silent",
});

try {
  const {
    rowClusters,
    colToTextStart,
    colToTextEnd,
    copySelectionText,
  } = await import(bundle);

  // ── 1. normalizeSelection ──
  console.log("\n[touchSelect] normalizeSelection");
  assert(
    JSON.stringify(
      normalizeSelection({ anchor: { abs: 2, col: 3 }, focus: { abs: 5, col: 1 } })
    ) === '{"startAbs":2,"startCol":3,"endAbs":5,"endCol":2}',
    "forward drag → anchor leads, endCol exclusive (+1)"
  );
  assert(
    JSON.stringify(
      normalizeSelection({ anchor: { abs: 5, col: 1 }, focus: { abs: 2, col: 3 } })
    ) === '{"startAbs":2,"startCol":3,"endAbs":5,"endCol":2}',
    "backward drag normalizes to the same range"
  );
  assert(
    JSON.stringify(
      normalizeSelection({ anchor: { abs: 4, col: 7 }, focus: { abs: 4, col: 7 } })
    ) === '{"startAbs":4,"startCol":7,"endAbs":4,"endCol":8}',
    "single-cell selection still covers that one cell"
  );

  // ── 2. selectionRowSegments ──
  console.log("\n[touchSelect] selectionRowSegments");
  assert(
    JSON.stringify(
      selectionRowSegments(
        { startAbs: 1, startCol: 4, endAbs: 3, endCol: 2 },
        10
      )
    ) ===
      '[{"abs":1,"startCol":4,"endCol":10},{"abs":2,"startCol":0,"endCol":10},{"abs":3,"startCol":0,"endCol":2}]',
    "head from startCol, interior full-width, tail to endCol"
  );
  assert(
    JSON.stringify(
      selectionRowSegments({ startAbs: 2, startCol: 5, endAbs: 2, endCol: 6 }, 80)
    ) === '[{"abs":2,"startCol":5,"endCol":6}]',
    "single-row segment is exactly the selected columns"
  );

  // ── 3. absCellFromPoint ──
  console.log("\n[touchSelect] absCellFromPoint");
  const geo = { offsetX: 0, scale: 1, cellW: 7, cellH: 14, cols: 80, totalRows: 100 };
  assert(
    JSON.stringify(absCellFromPoint({ ...geo, x: 8 + 7 * 12 + 3, y: 4 + 14 * 30 + 5 })) ===
      '{"abs":30,"col":12}',
    "content-space point → 0-based absolute strip cell (8/4 padding)"
  );
  assert(
    JSON.stringify(absCellFromPoint({ ...geo, scale: 0.5, x: 8 + 3.5 * 4 + 1, y: 4 + 7 * 9 + 2 })) ===
      '{"abs":9,"col":4}',
    "scale-to-fit shrink respected (scaled cell rects)"
  );
  assert(
    absCellFromPoint({ ...geo, cols: 0, x: 10, y: 10 }) === null &&
      JSON.stringify(absCellFromPoint({ ...geo, x: -50, y: 99999 })) ===
        '{"abs":99,"col":0}',
    "no grid → null; out-of-strip points clamp into the buffer"
  );

  // ── 4. rowClusters: wide + zero-width column math ──
  console.log("\n[copyText] rowClusters");
  const wideRow = [{ text: "a好b", cols: 4 }]; // 好 is CJK → 2 columns
  assert(
    JSON.stringify(rowClusters(wideRow)) ===
      '[{"utf16Start":0,"utf16End":1,"colStart":0,"width":1},{"utf16Start":1,"utf16End":2,"colStart":1,"width":2},{"utf16Start":2,"utf16End":3,"colStart":3,"width":1}]',
    "annotated run: wide char spans 2 columns, neighbors shift"
  );
  const zwRow = [{ text: "éx", cols: 2 }]; // e + combining accent
  assert(
    JSON.stringify(rowClusters(zwRow)) ===
      '[{"utf16Start":0,"utf16End":2,"colStart":0,"width":1},{"utf16Start":2,"utf16End":3,"colStart":1,"width":1}]',
    "zero-width combiner folds into the preceding cluster"
  );

  // ── 5. column → text boundaries (wide-char inclusion) ──
  console.log("\n[copyText] colToTextStart / colToTextEnd");
  assert(
    colToTextStart(wideRow, 2) === 1 && colToTextStart(wideRow, 1) === 1,
    "start on EITHER half of a wide char includes the whole char"
  );
  assert(
    colToTextEnd(wideRow, 2) === 2 && colToTextEnd(wideRow, 3) === 2,
    "exclusive end landing inside a wide char includes it"
  );
  assert(
    colToTextStart(wideRow, 99) === 3 && colToTextEnd(wideRow, 0) === 0,
    "past-content start → text length; end at col 0 → empty"
  );

  // ── 6. copySelectionText: assembly semantics ──
  console.log("\n[copyText] copySelectionText");
  const rows = new Map([
    [0, { text: "hello   ", runs: [{ text: "hello   " }] }],
    [1, { text: "wor", runs: [{ text: "wor" }], wrapped: true }],
    [2, { text: "ld!  ", runs: [{ text: "ld!  " }] }],
    [3, { text: "", runs: [] }],
    [4, { text: "tail", runs: [{ text: "tail" }] }],
  ]);
  const rowAt = (abs) => rows.get(abs);
  assert(
    copySelectionText(rowAt, { startAbs: 0, startCol: 0, endAbs: 4, endCol: 4 }) ===
      "hello\nworld!\n\ntail",
    "trailing spaces trim, soft-wrapped rows join without a newline, empty row = bare newline"
  );
  assert(
    copySelectionText(rowAt, { startAbs: 0, startCol: 1, endAbs: 0, endCol: 4 }) === "ell",
    "single-row column sub-range"
  );
  const bareRows = (abs) => (abs === 0 ? { text: "no-runs row  " } : undefined);
  assert(
    copySelectionText(bareRows, { startAbs: 0, startCol: 3, endAbs: 1, endCol: 5 }) ===
      "runs row\n",
    "HTTP-fallback bare-text rows synthesize one-col-per-char runs; missing rows are empty"
  );
  const wideRows = (abs) => (abs === 0 ? { text: "a好b", runs: wideRow } : undefined);
  assert(
    copySelectionText(wideRows, { startAbs: 0, startCol: 2, endAbs: 0, endCol: 4 }) === "好b",
    "grid-coordinate selection through the cluster math (wide-char inclusion)"
  );
} finally {
  await unlink(bundle).catch(() => {});
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall copy/select tests passed");
