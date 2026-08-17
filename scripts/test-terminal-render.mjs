// T2 headless render: the presentational grid parts
// (components/TerminalGridParts.tsx) rendered to HTML with
// react-dom/server — no DOM, no sockets. Verifies the faithful grid
// rows (fixed width, never wraps, column-anchored wide chars) and
// that every chrome badge/pill actually materializes.
//
// TSX needs a transform (Node strips types, not JSX), so the module
// is bundled on the fly with esbuild (already present as vite's
// dependency) into scripts/.t2-render.bundle.mjs (deleted after; react
// stays external and resolves through the repo's node_modules).
//
// Run:  node scripts/test-terminal-render.mjs

import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, ".t2-render.bundle.mjs");

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

await build({
  entryPoints: [path.join(here, "../src/components/TerminalGridParts.tsx")],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  outfile: bundle,
  external: ["react", "react/jsx-runtime"],
  logLevel: "silent",
});

try {
  const { TerminalChrome, TerminalCursor } = await import(bundle);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement: h } = await import("react");
  const { initialClaimState, reduceClaim } = await import("../src/lib/claimState.ts");

  // Live rows are TerminalRow (src/kessel/rowRender.test.tsx).

  // ── TerminalCursor: the PTY's cursor at its true cell (T4) ──
  console.log("\n[TerminalCursor] session cursor rect");

  const cursor = renderToStaticMarkup(
    h(TerminalCursor, { row: 3, col: 10, cellW: 6, lineHeight: 14, shape: "block", visible: true })
  );
  assert(cursor.includes('data-k2="cursor"') && cursor.includes("left:60px") && cursor.includes("top:42px"),
    "block cursor lands at exactly its cell (col 10 × row 3)");
  assert(cursor.includes("width:6px") && cursor.includes("height:14px"),
    "block cursor fills one cell rect");
  assert(cursor.includes("pointer-events:none"),
    "cursor never intercepts touches");

  const barCursor = renderToStaticMarkup(
    h(TerminalCursor, { row: 0, col: 2, cellW: 6, lineHeight: 14, shape: "bar", visible: true })
  );
  assert(barCursor.includes('data-k2-cursor-shape="bar"') && barCursor.includes("width:2px"),
    "bar shape renders a 2px beam");

  const hidden = renderToStaticMarkup(
    h(TerminalCursor, { row: 3, col: 10, cellW: 6, lineHeight: 14, shape: "block", visible: false })
  );
  assert(hidden === "", "cursor_visible=false renders nothing");

  // ── TerminalChrome: badges / pills ──
  console.log("\n[TerminalChrome] badges and pills");
  const base = { passive: false, gridCols: 62, gridRows: 30, onClaim: () => {}, onRelease: () => {} };

  const idle = renderToStaticMarkup(h(TerminalChrome, { ...base, claim: initialClaimState }));
  assert(idle.includes('data-k2="claim-button"') && idle.includes("Claim session"),
    "claimer + unpinned → Claim session button");

  const claimed = reduceClaim(initialClaimState, { type: "claim_sent", cols: 62, rows: 30 });
  const claimedHtml = renderToStaticMarkup(h(TerminalChrome, { ...base, claim: claimed }));
  assert(claimedHtml.includes('data-k2="claimed-badge"') &&
         claimedHtml.includes("Claimed — this phone owns the size"),
    "claimed → loud release badge");
  assert(!claimedHtml.includes('data-k2="claim-button"'),
    "claimed → claim button gone");

  const pinned = reduceClaim(initialClaimState, { type: "pin_initial", cols: 120, rows: 40, setBy: "owner" });
  const pinnedHtml = renderToStaticMarkup(h(TerminalChrome, { ...base, claim: pinned }));
  assert(pinnedHtml.includes('data-k2="pin-badge"') && pinnedHtml.includes("Pinned 120×40 by owner"),
    "pinned by other → pin badge with dims + setter");
  assert(!pinnedHtml.includes('data-k2="claim-button"'),
    "pinned by other → no claim affordance");

  const viewer = reduceClaim(initialClaimState, { type: "mode", mode: "viewer", capable: false });
  const viewerHtml = renderToStaticMarkup(
    h(TerminalChrome, { ...base, claim: viewer, passive: true, gridCols: 190, gridRows: 50 })
  );
  assert(viewerHtml.includes('data-k2="viewer-pill"') && viewerHtml.includes("View only"),
    "viewer → read-only pill, no claim UI");
  assert(viewerHtml.includes('data-k2="viewing-pill"') && viewerHtml.includes("Viewing at 190×50"),
    "scaled to someone else's dims → Viewing at C×R pill");

  const passiveHtml = renderToStaticMarkup(
    h(TerminalChrome, { ...base, claim: initialClaimState, passive: true, gridCols: 190, gridRows: 50 })
  );
  assert(passiveHtml.includes("Viewing at 190×50") && passiveHtml.includes("Claim session"),
    "desktop drove the dims → pill AND the claim affordance together");

  // ── T6: selection overlay + copy affordance + clipboard pills ──
  console.log("\n[T6] selection + clipboard UX parts");
  const { SelectionOverlay, CopyAffordance, ToastPill, ClipboardFallbackPill } =
    await import(bundle);

  const overlay = renderToStaticMarkup(
    h(SelectionOverlay, {
      segments: [
        { abs: 2, startCol: 4, endCol: 10 },
        { abs: 3, startCol: 0, endCol: 6 },
      ],
      cellW: 6,
      lineHeight: 14,
    })
  );
  assert(overlay.includes('data-k2="selection-overlay"') &&
         (overlay.match(/data-k2="selection-rect"/g) ?? []).length === 2,
    "selection overlay renders one rect per row segment");
  assert(overlay.includes("left:24px") && overlay.includes("top:28px") &&
         overlay.includes("width:36px") && overlay.includes("height:14px"),
    "head rect sits at exactly its column/row rect (grid space)");
  assert(!overlay.replace(/pointer-events:none/g, "").includes("pointer-events"),
    "overlay is fully pointer-transparent");

  const copyBtn = renderToStaticMarkup(
    h(CopyAffordance, { left: 42, top: 90, onCopy: () => {} })
  );
  assert(copyBtn.includes('data-k2="copy-button"') && copyBtn.includes(">Copy<"),
    "copy affordance renders a Copy button");
  assert(copyBtn.includes("data-k2-copy-ui") &&
         copyBtn.includes("left:42px") && copyBtn.includes("top:90px"),
    "copy button carries the gesture-layer opt-out marker at its spot");

  const toastHtml = renderToStaticMarkup(h(ToastPill, { text: "Copied" }));
  assert(toastHtml.includes('data-k2="toast"') && toastHtml.includes("Copied"),
    "toast pill renders its text");

  const fb = renderToStaticMarkup(
    h(ClipboardFallbackPill, { text: "secret paste", onCopy: () => {}, onDismiss: () => {} })
  );
  assert(fb.includes('data-k2="clipboard-fallback"') && fb.includes("secret paste") &&
         fb.includes('data-k2="clipboard-fallback-copy"') &&
         fb.includes('data-k2="clipboard-fallback-dismiss"'),
    "clipboard fallback pill shows the text with manual Copy + dismiss");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await unlink(bundle).catch(() => {});
}
