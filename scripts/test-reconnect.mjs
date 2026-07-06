// T5b pure tests: grid-WS reconnect backoff schedule
// (lib/reconnect.ts) — desktop Kessel parity: 500·2^min(n,4), cap 5s.
//
// Run:  node scripts/test-reconnect.mjs

import {
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
} from "../src/lib/reconnect.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

console.log("\n[reconnect] backoff schedule");
assert(
  [0, 1, 2, 3, 4].map(reconnectDelayMs).join(",") === "500,1000,2000,4000,5000",
  "attempts 0..4 → 500,1000,2000,4000,5000 (8000 clips at the 5s cap)"
);
assert(
  reconnectDelayMs(5) === 5000 && reconnectDelayMs(100) === 5000,
  "exponent pins at n=4 — a sustained outage retries every 5s forever"
);
assert(
  reconnectDelayMs(-3) === RECONNECT_BASE_MS && RECONNECT_CAP_MS === 5000,
  "negative attempts clamp to the 500ms base"
);

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall reconnect tests passed");
