// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("../api/client", () => ({ serverHasFeature: vi.fn() }));

import {
  parseRegisterReply,
  previewsPref,
  PUSH_PREVIEWS_KEY,
  readPushPreviews,
  usePushPreviewsStore,
} from "./pushPreviews";

beforeEach(() => {
  localStorage.clear();
  usePushPreviewsStore.setState({ previews: {}, allowed: {}, feature: {}, errors: {} });
});

describe("parseRegisterReply", () => {
  it("reads previews and previewsAllowed from a JSON body or object", () => {
    expect(parseRegisterReply('{"ok":true,"previews":false,"previewsAllowed":true}')).toEqual({
      previews: false,
      previewsAllowed: true,
    });
    expect(parseRegisterReply({ previews: true, previewsAllowed: false })).toEqual({
      previews: true,
      previewsAllowed: false,
    });
  });

  it("anything else reads as null (older daemon, junk, non-booleans)", () => {
    const none = { previews: null, previewsAllowed: null };
    expect(parseRegisterReply('{"ok":true}')).toEqual(none);
    expect(parseRegisterReply("")).toEqual(none);
    expect(parseRegisterReply("not json")).toEqual(none);
    expect(parseRegisterReply(null)).toEqual(none);
    expect(parseRegisterReply({ previews: "true", previewsAllowed: 0 })).toEqual(none);
  });
});

describe("pref persistence", () => {
  it("defaults to on, persists per server, and is forgotten with the server", () => {
    expect(previewsPref("s1")).toBe(true);
    usePushPreviewsStore.getState().setPref("s1", false);
    usePushPreviewsStore.getState().noteReply("s1", undefined, {
      previews: null,
      previewsAllowed: false,
    });
    expect(previewsPref("s1")).toBe(false);
    expect(previewsPref("s2")).toBe(true);
    expect(readPushPreviews()).toEqual({ previews: { s1: false }, allowed: { s1: false } });
    usePushPreviewsStore.getState().forget("s1");
    expect(readPushPreviews()).toEqual({ previews: {}, allowed: {} });
  });

  it("a corrupt stored value reads as empty", () => {
    localStorage.setItem(PUSH_PREVIEWS_KEY, "{oops");
    expect(readPushPreviews()).toEqual({ previews: {}, allowed: {} });
    localStorage.setItem(PUSH_PREVIEWS_KEY, '{"previews":{"s1":"no","s2":false}}');
    expect(readPushPreviews()).toEqual({ previews: { s2: false }, allowed: {} });
  });
});
