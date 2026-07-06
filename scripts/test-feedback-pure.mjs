// Validates the Feedback page's pure logic (C3): status sectioning,
// the TabBar waiting-badge count, /events frame filtering, relative
// ages, and the composer receipt lines.
//
// Run:  node scripts/test-feedback-pure.mjs   (Node 24 native TS
// type-stripping for the .ts import — the test-grid-convert.mjs idiom).

import {
  groupByStatus, countWaiting, sortNewestFirst, feedbackEventTargets,
  relativeAge, deliveredLine, optionsActionable, filterBySearch, sortRows,
} from "../src/api/feedbackPure.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

const rows = [
  { id: "a", status: "waiting", createdAt: 100 },
  { id: "b", status: "answered", createdAt: 300 },
  { id: "c", status: "resolved", createdAt: 200 },
  { id: "d", status: "dismissed", createdAt: 400 },
  { id: "e", status: "waiting", createdAt: 500 },
];
const g = groupByStatus(rows);
assert(g.waiting.length === 2 && g.answered.length === 1 && g.closed.length === 2, "groupByStatus sections");
assert(countWaiting(rows) === 2, "countWaiting badge count");
assert(sortNewestFirst(rows).map(r => r.id).join("") === "edbca", "sortNewestFirst order");
assert(feedbackEventTargets("feedback:created")?.list === true && feedbackEventTargets("feedback:created")?.thread === false, "created -> list only");
assert(feedbackEventTargets("feedback:commented")?.thread === true && feedbackEventTargets("feedback:commented")?.list === false, "commented -> thread only");
assert(feedbackEventTargets("feedback:answered")?.list && feedbackEventTargets("feedback:answered")?.thread, "answered -> both");
assert(feedbackEventTargets("feedback:status-changed")?.list && feedbackEventTargets("feedback:status-changed")?.thread, "status-changed -> both");
assert(feedbackEventTargets("agent:lifecycle") === null && feedbackEventTargets("project-group:message-created") === null, "non-feedback events ignored");
assert(relativeAge(0, 30) === "now" && relativeAge(0, 300) === "5m" && relativeAge(0, 7200) === "2h" && relativeAge(0, 200000) === "2d", "relativeAge buckets");
assert(deliveredLine("appa", true, null) === "sent to appa's session", "delivered line");
assert(deliveredLine("appa", false, "session_gone").includes("session gone"), "failure line carries reason");
assert(optionsActionable({ status: "waiting", options: ["y"] }) === true && optionsActionable({ status: "answered", options: ["y"] }) === false, "optionsActionable");

// ── filterBySearch (tokenized, title/body/workspace/agent/kind/status/id) ──
const searchRows = [
  { id: "f1", title: "Deploy blocked", body: "waiting on approval https://ci.example.com/run/9912", agentName: "appa", projectName: "K2", kind: "approval", status: "waiting" },
  { id: "f2", title: "Rename question", body: null, agentName: "momo", projectName: "Companion", kind: "question", status: "answered" },
  { id: "f3", title: "FYI: nightly green", body: "all suites", agentName: "appa", projectName: "K2", kind: "fyi", status: "resolved" },
];
assert(filterBySearch(searchRows, "").length === 3 && filterBySearch(searchRows, "   ").length === 3, "empty/whitespace query = no filter");
assert(filterBySearch(searchRows, "DEPLOY").map(r => r.id).join() === "f1", "case-insensitive title match");
assert(filterBySearch(searchRows, "ci.example.com").map(r => r.id).join() === "f1", "body match (null body safe)");
assert(filterBySearch(searchRows, "companion").map(r => r.id).join() === "f2", "workspace match");
assert(filterBySearch(searchRows, "appa k2").map(r => r.id).join() === "f1,f3", "every token must match (agent+workspace)");
assert(filterBySearch(searchRows, "appa question").length === 0, "tokens AND across fields");

// ── sortRows (applied within a status section) ──
const sortable = [
  { id: "s1", createdAt: 100, priority: 3, projectName: "zeta" },
  { id: "s2", createdAt: 300, priority: 1, projectName: "Alpha" },
  { id: "s3", createdAt: 200, priority: 2, projectName: "beta" },
  { id: "s4", createdAt: 400, priority: 1, projectName: "alpha" },
];
assert(sortRows(sortable, "newest").map(r => r.id).join() === "s4,s2,s3,s1", "sort newest");
assert(sortRows(sortable, "oldest").map(r => r.id).join() === "s1,s3,s2,s4", "sort oldest");
assert(sortRows(sortable, "priority").map(r => r.id).join() === "s4,s2,s3,s1", "sort priority P1 first, newest tie-break");
assert(sortRows(sortable, "workspace").map(r => r.id).join() === "s4,s2,s3,s1", "sort workspace A–Z case-insensitive, newest tie-break");
assert(sortRows(sortable, "newest") !== sortable && sortable[0].id === "s1", "sortRows does not mutate input");
process.exit(failures ? 1 : 0);
