// T4 headless smoke: ChatSession's input-bar slot across the three
// states, rendered to HTML with react-dom/server — no DOM, no sockets
// (effects never run under renderToStaticMarkup):
//   Safe (default) → MessageComposer textarea, NO accessory bar/capture;
//   Direct         → LiveInputCapture + AccessoryBar, NO composer;
//   viewer         → neither.
// Plus the TerminalCursor at its exact cell rect.
//
// The page's real import graph pulls the Tauri plugins, so esbuild
// bundles a tiny entry with @tauri-apps/* aliased to inert stubs
// (deleted after; react/react-dom/react-router-dom stay external and
// resolve through the repo's node_modules — one shared React).
//
// Run:  node scripts/test-live-input-ui.mjs

import { build } from "esbuild";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, ".t4-ui.entry.ts");
const stub = path.join(here, ".t4-ui.stub.ts");
const bundle = path.join(here, ".t4-ui.bundle.mjs");

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

// Browser globals the render path touches (ChatSession seeds state from
// window.innerHeight; everything else lives in effects, which never run
// here).
globalThis.window = {
  innerHeight: 800,
  devicePixelRatio: 2,
  visualViewport: undefined,
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
};
globalThis.document = globalThis.document ?? {
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

await writeFile(
  entry,
  `export { ChatSession } from "../src/pages/ChatSession";
export { setSendMode, setSessionRole, __resetSendModeForTests } from "../src/lib/sendMode";
`
);
await writeFile(
  stub,
  `export const fetch = async () => { throw new Error("tauri stub"); };
export const load = async () => ({ get: async () => null, set: async () => {}, save: async () => {}, delete: async () => {} });
export const invoke = async () => null;
export const convertFileSrc = (p) => p;
export default {};
`
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  outfile: bundle,
  external: ["react", "react/jsx-runtime", "react-dom", "react-router-dom"],
  alias: {
    "@tauri-apps/plugin-http": stub,
    "@tauri-apps/plugin-store": stub,
    "@tauri-apps/api/core": stub,
  },
  logLevel: "silent",
});

try {
  const { ChatSession, setSendMode, setSessionRole, __resetSendModeForTests } =
    await import(bundle);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement: h } = await import("react");
  const { MemoryRouter, Routes, Route } = await import("react-router-dom");

  const TID = "t4-term-1";
  const page = () =>
    renderToStaticMarkup(
      h(
        MemoryRouter,
        { initialEntries: [`/chat/${TID}`] },
        h(Routes, null, h(Route, { path: "/chat/:terminalId", element: h(ChatSession) }))
      )
    );

  // ── Safe (default) ──
  console.log("\n[safe] default mode renders the composer");
  __resetSendModeForTests();
  let html = page();
  assert(html.includes("<textarea"), "composer textarea present");
  assert(html.includes("Message the agent"), "safe placeholder present");
  assert(html.includes('data-k2="mode-toggle"'), "header icon toggle present");
  assert(html.includes('aria-label="Switch to direct typing"'), "toggle labeled 'Switch to direct typing' in Safe");
  assert(!html.includes("&gt;_"), "toggle shows the chat bubble (not >_) in Safe");
  assert(!html.includes("Safe send") && !html.includes("Direct type"), "old segmented control GONE");
  assert(!html.includes('data-k2="accessory-bar"'), "NO accessory bar in Safe");
  assert(!html.includes('data-k2="live-capture"'), "NO hidden capture in Safe");

  // ── Direct ──
  console.log("\n[direct] composer unmounts; live strip renders");
  setSendMode(TID, "direct");
  html = page();
  assert(!html.includes("<textarea"), "composer is GONE (unmounted, not hidden)");
  assert(html.includes('data-k2="live-capture"'), "hidden capture input present");
  assert(html.includes('data-k2="accessory-bar"'), "accessory bar present");
  assert(html.includes('data-k2="mode-toggle"'), "header icon toggle still visible (the way back)");
  assert(html.includes('aria-label="Switch to safe send"'), "toggle labeled 'Switch to safe send' in Direct");
  assert(html.includes("&gt;_"), "toggle shows >_ (Direct active)");
  assert(!html.includes("keystrokes are live"), "old live-warning caption GONE");
  assert(!html.includes("rgba(245, 158, 11, 0.10)"), "amber tint GONE (accessory strip IS the Direct cue)");
  for (const id of ["escape", "shiftTab", "newline", "arrowUp", "ctrlC", "ctrlU", "backspace"]) {
    assert(html.includes(`data-k2-key="${id}"`), `accessory key ${id} rendered`);
  }
  // Orca-exact chord labels + key-symbol glyph wrapping.
  assert(html.includes("Ctrl+C") && html.includes("Shift+Tab") && html.includes("Ctrl+U"), "Orca full chord labels rendered");
  assert(!/[>"]\^[CDZLRAEWU]</.test(html), "no ^X shorthand labels remain");
  assert(html.includes('<span class="key-symbol">⌫</span>'), "backspace glyph wrapped in .key-symbol");
  assert(html.includes('<span class="key-symbol">↑</span>'), "arrow glyph wrapped in .key-symbol");
  assert(html.includes('<span class="key-symbol">⇧⏎</span>'), "newline key ⇧⏎ glyphs wrapped in .key-symbol");
  const capture = html.match(/<input[^>]*data-k2="live-capture"[^>]*>/)?.[0] ?? "";
  assert(/autocapitalize="off"/i.test(capture), "capture: autocapitalize off");
  assert(/autocorrect="off"/i.test(capture), "capture: autocorrect off");
  assert(/spellcheck="false"/i.test(capture), "capture: spellcheck off");
  assert(/autocomplete="off"/i.test(capture), "capture: autocomplete off");
  assert(/enterkeyhint="enter"/i.test(capture), "capture: enterkeyhint=enter");
  assert(/opacity:0/.test(capture), "capture: invisible (opacity 0)");

  // ── Viewer / Watch: composer stays (Safe send → terminal.write) ──
  console.log("\n[viewer] Watch keeps Safe send");
  setSessionRole(TID, "viewer");
  html = page();
  assert(!html.includes("View-only"), "Watch does not hide the composer");
  assert(html.includes("<textarea"), "Safe send composer stays for viewers");
  assert(html.includes('data-k2="mode-toggle"'), "mode toggle stays (Watch is not a messaging gate)");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await unlink(bundle).catch(() => {});
  await unlink(entry).catch(() => {});
  await unlink(stub).catch(() => {});
}
