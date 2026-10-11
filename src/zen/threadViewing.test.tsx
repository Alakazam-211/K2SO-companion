// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
    serverHasFeature: vi.fn(),
  };
});
vi.mock("./overlayEvents", () => ({ connectOverlayEvents: vi.fn() }));

import { serverHasFeature } from "../api/client";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
import { useServersStore } from "../stores/servers";
import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";

let vis: DocumentVisibilityState = "visible";
const setViewing = vi.fn();
const stop = vi.fn();

function setVisibility(v: DocumentVisibilityState) {
  vis = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vis = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
  setViewing.mockReset();
  stop.mockReset();
  vi.mocked(connectOverlayEvents).mockReturnValue({ stop, setViewing });
  useNotifyPrefsStore.setState({ threadPush: {}, prefs: {}, errors: {} });
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "t", url: "https://h.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
  });
  useZenStore.setState({
    threadSource: "live",
    threadAddr: "k2",
    threadGroupId: null,
    threadConversationId: "conv-1",
    threadError: null,
    thread: [],
  });
});
afterEach(() => cleanup());

const lastViewing = () => setViewing.mock.lastCall?.[0];

describe("Thread viewing frames", () => {
  // Unmount: the handle's stop() sends visible:false itself (overlayEvents.test).
  it("with thread-push-v1: true on open, false on hide, true on return, stop on unmount", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    const { unmount } = render(<ThreadPane />);
    await act(async () => {});
    expect(serverHasFeature).toHaveBeenCalledWith("thread-push-v1", "s1");
    expect(lastViewing()).toBe(true);
    setVisibility("hidden");
    expect(lastViewing()).toBe(false);
    setVisibility("visible");
    expect(lastViewing()).toBe(true);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a full-screen overlay (file viewer) counts as not viewing", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    const { rerender } = render(<ThreadPane />);
    await act(async () => {});
    expect(lastViewing()).toBe(true);
    rerender(<ThreadPane covered />);
    expect(lastViewing()).toBe(false);
  });

  it("without the feature, never says it is viewing", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    const { unmount } = render(<ThreadPane />);
    await act(async () => {});
    setVisibility("hidden");
    setVisibility("visible");
    unmount();
    expect(setViewing).not.toHaveBeenCalledWith(true);
  });
});
