// Headless render check for the list pages (mobile UX wave):
//   - Feedback list renders the search input + segmented sort control,
//     and a hostile fixture (unbroken 240-char title, long URL body)
//     lands inside a card that carries the overflow-containment classes
//     (min-w-0 chain, line-clamp, overflow-wrap:anywhere) — the classes
//     ARE the fix, so their presence on the rendered card is the assert.
//   - Projects list renders pinned groups first under the "Pinned"
//     label, then the unpinned tail alphabetically.
//
// Real ReactDOMServer render of the actual pages (no jsdom): esbuild
// bundles the pages with `@tauri-apps/*` stubbed (renderToString runs no
// effects, so no fetch/WS ever fires), then the bundle self-asserts.
//
// Run:  node scripts/test-list-pages-render.mjs

import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const entry = /* tsx */ `
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Feedback } from "./src/pages/Feedback";
import { ProjectsPage } from "./src/pages/Projects";
import { useFeedbackStore } from "./src/stores/feedback";
import { useServersStore } from "./src/stores/servers";
import { useProjectGroupsStore } from "./src/stores/projectGroups";

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg);
};

// zustand v5 serves getInitialState() to useSyncExternalStore during SSR
// (hydration-mismatch guard), so renderToString ignores setState — and the
// bound hook's methods are Object.assign COPIES, so re-pointing
// getInitialState on it never reaches the inner api. But getInitialState()
// returns the very object the SSR snapshot selects from: mutate that.
const prime = (store: { getInitialState: () => object }, patch: object) =>
  Object.assign(store.getInitialState(), patch);

// ── Feedback list ──
const LONG_TITLE = "T" + "x".repeat(239); // unbroken 240-char string
const LONG_URL = "https://ci.example.com/" + "a".repeat(180);
const base = {
  projectId: "p", sessionId: null, sessionKind: null, options: null,
  answer: null, answeredAt: null, updatedAt: 0, projectPath: "/w",
};
prime(useServersStore, { activeServerId: "srv-test" });
prime(useFeedbackStore, {
  rows: [
    { ...base, id: "long", title: LONG_TITLE, body: LONG_URL, agentName: "appa",
      projectName: "K2", kind: "question", status: "waiting", priority: 1,
      createdAt: 100, commentCount: 1 },
    { ...base, id: "tame", title: "Short one", body: null, agentName: "momo",
      projectName: "Companion", kind: "fyi", status: "answered", priority: 3,
      createdAt: 200, commentCount: 2 },
  ] as never,
  isLoading: false,
  error: null,
});
const feedbackHtml = renderToString(
  <MemoryRouter initialEntries={["/"]}><Feedback /></MemoryRouter>
);
assert(feedbackHtml.includes('placeholder="Search feedback..."'), "feedback: search input rendered");
for (const label of ["Newest", "Oldest", "Priority", "Workspace"]) {
  assert(feedbackHtml.includes(">" + label + "<"), "feedback: sort segment '" + label + "'");
}
assert(feedbackHtml.includes("Waiting on you"), "feedback: waiting section first-class");
assert(feedbackHtml.includes(LONG_TITLE), "feedback: long-title fixture rendered");
const longCard = feedbackHtml.split("<button").find((c) => c.includes(LONG_TITLE)) ?? "";
assert(longCard.includes("min-w-0"), "feedback: card carries min-w-0 chain");
assert(longCard.includes("line-clamp-2"), "feedback: title/body clamped (line-clamp-2)");
assert(longCard.includes("[overflow-wrap:anywhere]"), "feedback: unbroken strings wrap (overflow-wrap:anywhere)");
assert(longCard.includes("truncate"), "feedback: meta row truncates");
assert(longCard.includes("overflow-hidden"), "feedback: card clips (overflow-hidden)");

// ── Projects list ──
const g = (id: string, name: string, pinned: boolean) => ({
  id, name, pinned, pocWorkspaceId: null, color: null, sortOrder: 0,
  createdAt: 0, updatedAt: 0, memberCount: 1,
});
prime(useProjectGroupsStore, {
  groups: [g("1", "zulu", true), g("2", "delta", false), g("3", "Alpha", false)],
  loading: false,
  error: null,
  pocNames: {},
  unreadGroupIds: new Set<string>(),
  forServerId: "srv-test",
});
const projectsHtml = renderToString(
  <MemoryRouter initialEntries={["/"]}><ProjectsPage /></MemoryRouter>
);
assert(projectsHtml.includes(">Pinned<"), "projects: Pinned section label");
const order = ["zulu", "Alpha", "delta"].map((n) => projectsHtml.indexOf(n));
assert(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2],
  "projects: pinned first, then A-Z (zulu, Alpha, delta)");

// Exit code is decided by the wrapper AFTER temp-dir cleanup.
(globalThis as { __renderFailures?: number }).__renderFailures = failures;
`;

const tauriStub = `
export const fetch = async () => { throw new Error("tauri fetch stubbed (render check)"); };
export const load = async () => ({ get: async () => null, set: async () => {}, save: async () => {}, delete: async () => {} });
export const invoke = async () => null;
export default {};
`;

const dir = await mkdtemp(join(tmpdir(), "k2-list-render-"));
try {
  const out = join(dir, "bundle.mjs");
  await build({
    stdin: { contents: entry, resolveDir: repoRoot, loader: "tsx" },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: out,
    logLevel: "silent",
    // CJS deps (react-dom/server) require node builtins; give the ESM
    // bundle a real `require` for esbuild's shim to fall back to.
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "tauri-stub",
        setup(b) {
          b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
            path: args.path,
            namespace: "tauri-stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "tauri-stub" }, () => ({
            contents: tauriStub,
          }));
        },
      },
    ],
  });
  await import(pathToFileURL(out).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(globalThis.__renderFailures ? 1 : 0);
