#!/usr/bin/env node
// Screenshots of the theme preview (preview/theme.html): every screen ×
// palette × accent, in full Chromium and in WebKit, at iPhone size (393×852
// @3x). No server needed: the preview runs on fixtures with the network
// stubbed (src/preview/).
//
//   node scripts/theme-shots.mjs
//   node scripts/theme-shots.mjs --screens thread,home --palettes veil --accents default,#ff375f --engines webkit
//
// Writes <out>/<screen>__<palette>__<accent>.png (Chromium) and
// <out>/webkit/<screen>__<palette>__<accent>.png (WebKit); <accent> is
// `default` or the hex without `#`. Default out:
// /Users/Shared/k2-companion/theme-shots.
//
// Starts the preview dev server (vite --config preview/vite.config.ts, port
// 1430) unless one already answers, and stops the one it started.
//
// Playwright isn't a dependency of this repo: playwright-core is imported
// from an existing install (PLAYWRIGHT_CORE=/path/to/playwright-core, else
// the first of CANDIDATES below that exists). Its browsers come from
// ~/Library/Caches/ms-playwright. Chromium runs as the full browser
// (channel "chromium"), never the headless shell, which draws no
// backdrop-filter.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 1430;
const BASE = `http://127.0.0.1:${PORT}/preview/theme.html`;

const CANDIDATES = [
  process.env.PLAYWRIGHT_CORE,
  "/Users/zed/DevProjects/Alakazam Labs/K2-worktrees/integ-0462/node_modules/playwright-core",
  "/Users/zed/DevProjects/example/Rex/synthetic-user/node_modules/playwright-core",
].filter(Boolean);

const SCREENS = [
  "thread",
  "thread-jump",
  "home",
  "settings",
  "themes",
  "home-groups",
  "home-groups-sheet",
  "home-people",
  "home-people-menu",
  "home-same-person",
  "add-to-home",
  "add-to-home-channels",
  "add-to-home-new",
];
const PALETTES = ["obsidian", "veil", "yellow"];
const SCHEME = { obsidian: "dark", veil: "light", yellow: "dark" };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}
const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

const screens = list(arg("screens", SCREENS.join(",")));
const palettes = list(arg("palettes", PALETTES.join(",")));
const accents = list(arg("accents", "default,#ff375f"));
const engines = list(arg("engines", "chromium,webkit"));
const outDir = arg("out", "/Users/Shared/k2-companion/theme-shots");
const concurrency = Number(arg("jobs", "4")) || 4;

async function loadPlaywright() {
  for (const dir of CANDIDATES) {
    const entry = path.join(dir, "index.mjs");
    if (existsSync(entry)) {
      const pw = await import(pathToFileURL(entry).href);
      return { pw: pw.default ?? pw, dir };
    }
  }
  throw new Error(`No playwright-core found. Set PLAYWRIGHT_CORE. Tried:\n  ${CANDIDATES.join("\n  ")}`);
}

async function answers(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await answers(BASE)) return null;
  const vite = path.join(ROOT, "node_modules/.bin/vite");
  const child = spawn(vite, ["--config", "preview/vite.config.ts"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (await answers(BASE)) return child;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`The preview server did not start:\n${log}`);
}

/** The full Chromium build (not chromium_headless_shell), newest first:
 *  used only if channel "chromium" can't launch. */
function fullChromium() {
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const app of ["chrome-mac-arm64", "chrome-mac"]) {
      const exe = path.join(cache, d, app, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(exe)) return exe;
      const old = path.join(cache, d, app, "Chromium.app/Contents/MacOS/Chromium");
      if (existsSync(old)) return old;
    }
  }
  return null;
}

async function launch(pw, engine) {
  if (engine === "webkit") return pw.webkit.launch();
  try {
    return await pw.chromium.launch({ channel: "chromium" });
  } catch (e) {
    const exe = fullChromium();
    if (!exe) throw e;
    return pw.chromium.launch({ executablePath: exe, args: ["--headless=new"] });
  }
}

function jobsFor() {
  const out = [];
  for (const screen of screens)
    for (const palette of palettes)
      for (const accent of accents) out.push({ screen, palette, accent });
  return out;
}

function urlFor({ screen, palette, accent }) {
  const q = new URLSearchParams({ palette, screen: screen === "thread-jump" ? "thread" : screen });
  if (screen === "thread-jump") q.set("jump", "1");
  if (accent !== "default") q.set("accent", accent);
  return `${BASE}?${q}`;
}

const fileFor = ({ screen, palette, accent }) =>
  `${screen}__${palette}__${accent === "default" ? "default" : accent.replace(/^#/, "").toLowerCase()}.png`;

async function shoot(browser, engine, job, dir) {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    hasTouch: true,
    ...(engine === "chromium" ? { isMobile: true } : {}),
    colorScheme: SCHEME[job.palette] ?? "dark",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  try {
    await page.goto(urlFor(job), { waitUntil: "load" });
    await page.waitForFunction(() => window.__previewReady === true, null, { timeout: 20000 });
    const net = await page.evaluate(() => (window.__previewNet || []).length);
    const file = path.join(dir, fileFor(job));
    await page.screenshot({ path: file });
    return { file, errors, net };
  } finally {
    await context.close();
  }
}

async function main() {
  const { pw, dir: pwDir } = await loadPlaywright();
  const server = await ensureServer();
  const jobs = jobsFor();
  let failed = 0;
  try {
    for (const engine of engines) {
      const dir = engine === "chromium" ? outDir : path.join(outDir, engine);
      mkdirSync(dir, { recursive: true });
      let browser;
      try {
        browser = await launch(pw, engine);
      } catch (e) {
        console.error(`${engine}: can't launch (${String(e.message || e).split("\n")[0]}); skipped`);
        failed++;
        continue;
      }
      console.log(`${engine} ${browser.version()} (playwright-core from ${pwDir})`);
      const queue = [...jobs];
      const work = async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          try {
            const r = await shoot(browser, engine, job, dir);
            const notes = [r.net ? `${r.net} requests held` : "", r.errors.length ? `${r.errors.length} console errors` : ""]
              .filter(Boolean)
              .join(", ");
            console.log(`  ${path.relative(outDir, r.file)}${notes ? `  (${notes})` : ""}`);
            if (process.env.VERBOSE && r.errors.length) for (const e of r.errors) console.log(`    ! ${e}`);
          } catch (e) {
            failed++;
            console.error(`  ${fileFor(job)}: ${String(e.message || e).split("\n")[0]}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, work));
      await browser.close();
    }
  } finally {
    server?.kill();
  }
  console.log(`Done: ${outDir}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
