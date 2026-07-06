// Validates the mobile Projects list ordering (projectGroupsPure.ts):
// pinned block first in the daemon's relative order, then the unpinned
// tail alphabetical case-insensitive (sort_order deliberately ignored).
//
// Run:  node scripts/test-projects-pure.mjs   (Node 24 native TS
// type-stripping for the .ts import — the test-grid-convert.mjs idiom).

import { partitionPinnedAlpha } from "../src/api/projectGroupsPure.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

// Daemon order arrives pinned-first → sort_order → name; mobile keeps the
// pinned block stable and re-sorts the tail A–Z.
const groups = [
  { name: "zulu", pinned: true },
  { name: "Alpha", pinned: true },
  { name: "delta", pinned: false },
  { name: "Charlie", pinned: false },
  { name: "bravo", pinned: false },
];
const { pinned, rest } = partitionPinnedAlpha(groups);
assert(pinned.map(g => g.name).join() === "zulu,Alpha", "pinned block keeps daemon relative order");
assert(rest.map(g => g.name).join() === "bravo,Charlie,delta", "unpinned tail alphabetical case-insensitive");

// Interleaved input still partitions cleanly.
const mixed = partitionPinnedAlpha([
  { name: "b", pinned: false },
  { name: "P2", pinned: true },
  { name: "a", pinned: false },
  { name: "P1", pinned: true },
]);
assert(mixed.pinned.map(g => g.name).join() === "P2,P1", "interleaved pinned stays in arrival order");
assert(mixed.rest.map(g => g.name).join() === "a,b", "interleaved tail sorted");

// Edge cases: no pinned, all pinned, empty.
assert(partitionPinnedAlpha([]).pinned.length === 0 && partitionPinnedAlpha([]).rest.length === 0, "empty input");
const nopin = partitionPinnedAlpha([{ name: "x", pinned: false }, { name: "M", pinned: false }]);
assert(nopin.pinned.length === 0 && nopin.rest.map(g => g.name).join() === "M,x", "no pinned -> all alpha");
const allpin = partitionPinnedAlpha([{ name: "x", pinned: true }, { name: "M", pinned: true }]);
assert(allpin.rest.length === 0 && allpin.pinned.map(g => g.name).join() === "x,M", "all pinned -> stable, no tail");

// Input not mutated.
assert(groups[2].name === "delta" && groups.map(g => g.name).join() === "zulu,Alpha,delta,Charlie,bravo", "input array untouched");
process.exit(failures ? 1 : 0);
