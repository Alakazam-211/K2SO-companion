// Validates the workspaces store's cross-server hygiene (workspacesPure.ts):
// switching the ACTIVE server clears the previous server's snapshot
// (sessions / projects / summaries / selections) so a failed first fetch on
// the new server renders EMPTY — never the old server's session list as
// phantom UI (the 0-sessions-on-swap staleness bug). Same-server refreshes
// keep the snapshot on failure, and in-flight old-server responses are
// dropped after a swap.
//
// Run:  node scripts/test-sessions-swap-pure.mjs   (Node native TS
// type-stripping for the .ts import — the test-grid-convert.mjs idiom).

import {
  serverSwapReset,
  isStaleServerResponse,
} from "../src/stores/workspacesPure.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

// ── serverSwapReset: identity change → full server-scoped clear ──
const swap = serverSwapReset("server-A", "server-B");
assert(swap !== null, "A -> B identity change returns a reset slice");
assert(swap.forServerId === "server-B", "reset stamps the NEW server identity");
assert(
  Array.isArray(swap.allSessions) && swap.allSessions.length === 0,
  "reset clears allSessions (the stale Sessions page rows)"
);
assert(
  swap.projects.length === 0 && swap.summaries.length === 0,
  "reset clears projects + summaries"
);
assert(
  swap.activeProjectId === null && swap.activeFocusGroupId === null,
  "reset drops cross-server selections (project / focus group ids)"
);
assert(swap.error === null, "reset clears the previous server's error");

// Same identity → null: a failed same-server refetch (live event, pull)
// must KEEP the current list, not blank it.
assert(serverSwapReset("server-A", "server-A") === null, "same server -> no reset (keep-old-on-failure preserved)");
assert(serverSwapReset(null, null) === null, "no server before or after -> no reset");

// First load + server removal both count as identity changes.
assert(serverSwapReset(null, "server-A")?.forServerId === "server-A", "first load (null -> A) resets onto A");
assert(serverSwapReset("server-A", null)?.forServerId === null, "active server removed (A -> null) clears the snapshot");

// ── isStaleServerResponse: drop in-flight cross-server replies ──
assert(!isStaleServerResponse("server-A", "server-A"), "same-server response commits");
assert(isStaleServerResponse("server-A", "server-B"), "old-server response after a swap is dropped");
assert(isStaleServerResponse(null, "server-A"), "response started with no active server never commits onto A");
assert(!isStaleServerResponse(null, null), "no-server response with no server still active commits (no-op fetch)");

// ── Scenario: the reported bug, end to end over the pure rules ──
// Store holds server A's sessions; user swaps to server B which has ZERO
// sessions and whose first fetch FAILS (transient auth/network during the
// swap). Pre-fix the store kept A's rows forever; post-fix refreshAll
// applies the reset first, so the page shows the empty state.
let store = {
  forServerId: "server-A",
  allSessions: [{ terminalId: "t1", label: "old-A-session" }],
  projects: [{ id: "pA" }],
  summaries: [{ id: "pA" }],
  activeProjectId: "pA",
  activeFocusGroupId: "fgA",
  error: null,
};
const activeServerId = "server-B";
const reset = serverSwapReset(store.forServerId, activeServerId);
if (reset) store = { ...store, ...reset };
// First fetch against B fails -> guard `r.ok && r.data` commits nothing.
assert(store.allSessions.length === 0, "swap + failed fetch shows EMPTY, not server A's sessions");
assert(store.forServerId === "server-B", "snapshot identity is server B after the swap");
// A's slow in-flight reply lands AFTER the swap: must be dropped.
assert(isStaleServerResponse("server-A", activeServerId), "server A's late reply cannot repollute the store");
// A later same-server (B) event refetch that fails keeps B's data.
assert(serverSwapReset(store.forServerId, activeServerId) === null, "subsequent B refreshes never blank on failure");

process.exit(failures ? 1 : 0);
