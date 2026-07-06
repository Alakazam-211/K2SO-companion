// Validates the Feedback page's pure logic (C3): status sectioning,
// the TabBar waiting-badge count, /events frame filtering, relative
// ages, and the composer receipt lines.
//
// Run:  node scripts/test-feedback-pure.mjs   (Node 24 native TS
// type-stripping for the .ts import — the test-grid-convert.mjs idiom).

import {
  groupByStatus, countWaiting, sortNewestFirst, feedbackEventTargets,
  relativeAge, deliveredLine, optionsActionable,
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
process.exit(failures ? 1 : 0);
