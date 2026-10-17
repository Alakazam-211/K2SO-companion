// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFTS_KEY,
  DRAFTS_MAX,
  DRAFT_SAVE_MS,
  composerDraftKey,
  composerDraftOf,
  readDrafts,
  trimDrafts,
  useComposerDrafts,
} from "./composerDrafts";

const stored = () => JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useComposerDrafts.getState().reload();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("composerDraftKey", () => {
  it("is the outbox room key: server + addr, or server + project group", () => {
    expect(composerDraftKey("s1", null, "appa")).toBe("s1|t:appa");
    expect(composerDraftKey("s1", null, "appa/2")).toBe("s1|t:appa/2");
    expect(composerDraftKey("s1", "g-9", "appa")).toBe("s1|g:g-9");
    expect(composerDraftKey("s2", null, "appa")).toBe("s2|t:appa");
  });

  it("is null while the room has no server or address", () => {
    expect(composerDraftKey("", null, "appa")).toBeNull();
    expect(composerDraftKey(null, null, "appa")).toBeNull();
    expect(composerDraftKey("s1", null, null)).toBeNull();
    expect(composerDraftKey("s1", "  ", " ")).toBeNull();
  });
});

describe("useComposerDrafts", () => {
  it("keeps text in memory at once and writes it after a short quiet", () => {
    const s = useComposerDrafts.getState();
    s.setDraft("s1|t:appa", "hel");
    s.setDraft("s1|t:appa", "hello");
    expect(composerDraftOf("s1|t:appa")).toBe("hello");
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
    vi.advanceTimersByTime(DRAFT_SAVE_MS);
    expect(stored()["s1|t:appa"].text).toBe("hello");
  });

  it("flush writes now; a reload (relaunch) reads it back", () => {
    useComposerDrafts.getState().setDraft("s1|t:appa", "half a thought", 5);
    useComposerDrafts.getState().flush();
    expect(stored()).toEqual({ "s1|t:appa": { text: "half a thought", at: 5 } });
    useComposerDrafts.setState({ drafts: {} });
    useComposerDrafts.getState().reload();
    expect(composerDraftOf("s1|t:appa")).toBe("half a thought");
  });

  it("an empty or blank draft is dropped; no key keeps nothing", () => {
    const s = useComposerDrafts.getState();
    s.setDraft("s1|t:appa", "x");
    s.setDraft("s1|t:appa", "   ");
    s.setDraft(null, "lost");
    s.flush();
    expect(useComposerDrafts.getState().drafts).toEqual({});
    expect(stored()).toEqual({});
  });

  it("keeps only the newest drafts", () => {
    for (let i = 0; i < DRAFTS_MAX + 5; i++) {
      useComposerDrafts.getState().setDraft(`s1|t:a${i}`, `d${i}`, i);
    }
    const keys = Object.keys(useComposerDrafts.getState().drafts);
    expect(keys).toHaveLength(DRAFTS_MAX);
    expect(keys).not.toContain("s1|t:a0");
    expect(keys).toContain(`s1|t:a${DRAFTS_MAX + 4}`);
    expect(Object.keys(trimDrafts({ a: { text: "1", at: 1 }, b: { text: "2", at: 2 } }, 1))).toEqual(["b"]);
  });

  it("survives storage that throws: the draft stays in memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readDrafts()).toEqual({});
    useComposerDrafts.getState().setDraft("s1|t:appa", "still here");
    expect(() => useComposerDrafts.getState().flush()).not.toThrow();
    expect(composerDraftOf("s1|t:appa")).toBe("still here");
  });

  it("ignores junk in storage", () => {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ a: { text: "ok", at: 1 }, b: 3, c: { text: "" }, d: { text: 4 } }));
    expect(readDrafts()).toEqual({ a: { text: "ok", at: 1 } });
    localStorage.setItem(DRAFTS_KEY, "not json");
    expect(readDrafts()).toEqual({});
  });
});
