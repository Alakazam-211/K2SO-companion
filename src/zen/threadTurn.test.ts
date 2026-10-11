import { describe, expect, it } from "vitest";
import {
  applyActivityCatchUp,
  applyActivityFrame,
  coerceThreadTurn,
  createCatchUpGate,
  isActivityFrame,
  isThreadFrame,
} from "./threadTurn";

// Shape captured live from K2 0.45.3 `GET /cli/thread/activity` (line redacted by the daemon).
const BODY = {
  background: 1,
  end: null,
  line: "Running `npm test`",
  phase: "tool",
  phaseSince: 1_000_500,
  rev: 48,
  serverNow: 1_001_000,
  since: 1_000_000,
  startedAt: 1_000_000,
  state: "working",
  subagents: 0,
  subagentsDone: 0,
  tally: { cmd: 16, edit: 0, read: 0, search: 0 },
  turnId: "t-1",
  waitingOn: null,
};

describe("coerceThreadTurn", () => {
  it("reads the activity body and the clock skew", () => {
    const t = coerceThreadTurn(BODY, 1_000_900);
    expect(t).toMatchObject({
      turnId: "t-1",
      state: "working",
      phase: "tool",
      line: "Running `npm test`",
      background: 1,
      tally: { read: 0, search: 0, cmd: 16, edit: 0 },
      rev: 48,
      skewMs: 100,
      end: null,
    });
  });

  it("refuses bodies without a turn id, clock, or known state", () => {
    expect(coerceThreadTurn({ ...BODY, turnId: "" }, 0)).toBeNull();
    expect(coerceThreadTurn({ ...BODY, serverNow: undefined }, 0)).toBeNull();
    expect(coerceThreadTurn({ ...BODY, state: "busy" }, 0)).toBeNull();
    expect(coerceThreadTurn(null, 0)).toBeNull();
  });

  it("treats missing counts as zero and blank lines as none", () => {
    const t = coerceThreadTurn(
      { ...BODY, tally: undefined, subagents: -2, line: "  " },
      0
    );
    expect(t?.tally).toEqual({ read: 0, search: 0, cmd: 0, edit: 0 });
    expect(t?.subagents).toBe(0);
    expect(t?.line).toBeNull();
  });
});

describe("applyActivityFrame", () => {
  const frame = (activity: object) => ({ collection: "activity", seq: 0, id: "t-1", activity });

  it("ignores thread frames", () => {
    const before = coerceThreadTurn(BODY, 0);
    const thread = { collection: "thread", seq: 3, id: "m", doc: { body: "hi" } };
    expect(isActivityFrame(thread)).toBe(false);
    expect(applyActivityFrame(before, thread, 0)).toBe(before);
  });

  it("moves the same turn forward by rev only", () => {
    const cur = coerceThreadTurn(BODY, 0);
    const older = applyActivityFrame(cur, frame({ ...BODY, rev: 40, phase: "thinking" }), 0);
    expect(older).toBe(cur);
    const newer = applyActivityFrame(cur, frame({ ...BODY, rev: 49, phase: "thinking" }), 0);
    expect(newer?.phase).toBe("thinking");
  });

  it("lets a new turn replace the old one whatever its rev", () => {
    const cur = coerceThreadTurn(BODY, 0);
    const next = applyActivityFrame(cur, frame({ ...BODY, turnId: "t-2", rev: 1 }), 0);
    expect(next?.turnId).toBe("t-2");
  });
});

describe("applyActivityCatchUp", () => {
  it("clears on {turn: null} and keeps on a body without turn", () => {
    const cur = coerceThreadTurn(BODY, 0);
    expect(applyActivityCatchUp(cur, { ok: true, turn: null }, 0)).toBeNull();
    expect(applyActivityCatchUp(cur, { ok: false }, 0)).toBe(cur);
  });

  it("adopts a live turn", () => {
    expect(applyActivityCatchUp(null, { ok: true, turn: BODY }, 0)?.turnId).toBe("t-1");
  });
});

describe("isThreadFrame", () => {
  it("takes thread and untagged items, nothing else", () => {
    expect(isThreadFrame({ collection: "thread", id: "a" })).toBe(true);
    expect(isThreadFrame({ id: "a", doc: {} })).toBe(true);
    for (const c of ["chatter", "chatterlog", "activity", "address", "moved"]) {
      expect(isThreadFrame({ collection: c, id: "a" })).toBe(false);
    }
    expect(isThreadFrame(null)).toBe(false);
  });
});

describe("createCatchUpGate", () => {
  it("accepts only the newest catch-up issued", () => {
    const gate = createCatchUpGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("drops a catch-up that an activity frame overtook", () => {
    const gate = createCatchUpGate();
    const pending = gate.begin();
    gate.frame();
    expect(pending()).toBe(false);
    expect(gate.begin()()).toBe(true);
  });
});
