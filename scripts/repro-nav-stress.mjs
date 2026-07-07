// Navigation stress harness for the /servers ↔ /login boundary (the
// freeze/no-op investigation, 2026-07). Drives the real UI in a browser
// while a zustand sync-update storm runs (models the revive/reconnect
// recovery churn a daemon rebuild causes) and asserts every crossing
// lands, both directions.
//
// What it guards against (both fixed):
//  1. react-router v7 startTransition-wrapped navigations being starved
//     by useSyncExternalStore (zustand) sync updates → silent no-op nav.
//     Fixed with <BrowserRouter unstable_useTransitions={false}> + /login
//     nested inside AppLayout (the shell no longer unmounts per crossing).
//  2. (iOS-only, not reachable in this harness) tauri 2.10.3 plugin-IPC
//     mutex deadlock on the boundary's plugin invoke churn — fixed by the
//     tauri >= 2.11.5 bump; verified on-simulator via thread samples.
//
// Prereqs (see scripts/repro-nav-stress-README anchor comments below):
//  - a vite dev server over this repo with @tauri-apps/plugin-http aliased
//    to window.fetch (browser mode), default http://localhost:5198
//  - a fake daemon with /ctl/revoke + /ctl/restore, default :5299
//  - playwright installed wherever you run this from
//
// Usage: node scripts/repro-nav-stress.mjs [chromium|webkit] [stormMs] [rounds]
// Exits non-zero on any wedge/freeze.
import { chromium, webkit } from "playwright";

const engineName = process.argv[2] ?? "chromium";
const engine = engineName === "webkit" ? webkit : chromium;
const STORM_MS = Number(process.argv[3] ?? 10);
const ROUNDS = Number(process.argv[4] ?? 10);
const BASE = process.env.REPRO_BASE ?? "http://localhost:5198";
const DAEMON = process.env.REPRO_DAEMON ?? "http://localhost:5299";

await fetch(`${DAEMON}/ctl/restore`, { method: "POST" });

const browser = await engine.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));

await page.addInitScript(({ DAEMON }) => {
  localStorage.setItem("k2_servers.servers", JSON.stringify([
    { id: "srv-1", nickname: "Local", url: DAEMON, username: "rosson", rememberPassword: false },
  ]));
  localStorage.setItem("k2_servers.activeServerId", JSON.stringify("srv-1"));
  localStorage.setItem("k2_servers.tokens", JSON.stringify({ "srv-1": "tok-live" }));
  window.__beats = 0;
  setInterval(() => { window.__beats++; }, 100);
}, { DAEMON });

await page.goto(`${BASE}/servers`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Sync-update storm: recovery-state churn straight into the store.
// (window.__serversStore is exposed by src/main.tsx in dev builds; if it
// is absent the storm is skipped and this is a plain nav soak.)
const stormOn = await page.evaluate((ms) => {
  const s = window.__serversStore;
  if (!s) return false;
  let i = 0;
  window.__storm = setInterval(() => {
    s.getState().setRecovery("srv-1", i++ % 2 ? "reconnecting" : "reauthenticating");
  }, ms);
  return true;
}, STORM_MS);
console.log(`storm=${stormOn ? `${STORM_MS}ms` : "UNAVAILABLE (plain soak)"} engine=${engineName}`);

// Deterministic in-page clicks (no locator auto-retry: a page that
// re-renders every 10ms makes Playwright's actionability machinery
// re-resolve onto other buttons — that's harness noise, not app state).
const clickButton = (needle) =>
  page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      (x.textContent ?? "").includes(t)
    );
    if (!b) return false;
    b.click();
    return true;
  }, needle);

const state = () =>
  Promise.race([
    page.evaluate(() => ({ url: location.pathname, beats: window.__beats })),
    new Promise((_, rej) => setTimeout(() => rej(new Error("EVAL-TIMEOUT")), 4000)),
  ]);

let failures = 0;
for (let r = 0; r < ROUNDS; r++) {
  // Mid-soak daemon "rebuild": revoke tokens + kill sockets every 3rd
  // round, restore on the next — keeps the real revive path churning.
  if (r % 3 === 0) await fetch(`${DAEMON}/ctl/revoke`, { method: "POST" });
  if (r % 3 === 1) await fetch(`${DAEMON}/ctl/restore`, { method: "POST" });

  const okIn = await clickButton("Add server");
  await page.waitForTimeout(700);
  let sIn;
  try { sIn = await state(); } catch { console.log(`round ${r}: FREEZE entering /login`); failures++; break; }

  const okOut = await clickButton("Servers");
  await page.waitForTimeout(700);
  let sOut;
  try { sOut = await state(); } catch { console.log(`round ${r}: FREEZE leaving /login`); failures++; break; }

  const pass = okIn && okOut && sIn.url === "/login" && sOut.url === "/servers";
  if (!pass) failures++;
  console.log(`round ${r}: in=${sIn.url} out=${sOut.url}${pass ? "" : "  <-- FAIL"}`);
}

await fetch(`${DAEMON}/ctl/restore`, { method: "POST" }).catch(() => {});
console.log(failures === 0 ? `PASS: ${ROUNDS} rounds clean` : `FAIL: ${failures} bad rounds`);
await browser.close().catch(() => {});
process.exit(failures === 0 ? 0 : 2);
