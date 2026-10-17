// @vitest-environment jsdom
// Composer drafts: leaving a chat with a half-written message and coming
// back (or relaunching) puts it back; each room keeps its own; a send
// clears it; a Not sent message put back with Edit becomes the draft.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { getThread, postThread } from "../api/client";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { DRAFTS_KEY, useComposerDrafts } from "./composerDrafts";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const agents = [
  { id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" },
  { id: "momo", name: "momo", initial: "M", path: "/Users/Baden/Momo", addr: "momo" },
];

function openRoom(agentId = "appa", over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: agentId,
    threadGroupId: null,
    threadConversationId: null,
    agentId,
    agents,
    thread: [],
    outbox: [],
    sending: false,
    sendError: null,
    ...over,
  });
}

const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const send = () => fireEvent.submit(screen.getByTestId("composer-form"));
const stored = () => JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");

beforeEach(() => {
  localStorage.clear();
  useComposerDrafts.getState().reload();
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  openRoom();
});

afterEach(() => {
  cleanup();
  vi.mocked(postThread).mockReset();
  vi.mocked(getThread).mockReset();
  vi.restoreAllMocks();
});

describe("composer drafts", () => {
  it("leaving the chat and coming back restores the draft", () => {
    const first = render(<ThreadPane />);
    type("half a thought");
    first.unmount();
    // Leaving writes it at once (no waiting for the save debounce).
    expect(stored()["s1|t:appa"].text).toBe("half a thought");
    render(<ThreadPane />);
    expect(input().value).toBe("half a thought");
  });

  it("survives an app relaunch (storage read back)", () => {
    const first = render(<ThreadPane />);
    type("for later");
    first.unmount();
    useComposerDrafts.setState({ drafts: {} });
    useComposerDrafts.getState().reload();
    render(<ThreadPane />);
    expect(input().value).toBe("for later");
  });

  it("each thread keeps its own draft, switching in place", () => {
    render(<ThreadPane />);
    type("for appa");
    act(() => openRoom("momo"));
    expect(input().value).toBe("");
    type("for momo");
    act(() => openRoom("appa"));
    expect(input().value).toBe("for appa");
    // A sidecar and a project chat are rooms of their own.
    act(() => openRoom("appa", { threadAddr: "appa/2" }));
    expect(input().value).toBe("");
    act(() => openRoom("appa", { threadGroupId: "g-1" }));
    expect(input().value).toBe("");
    act(() => openRoom("momo"));
    expect(input().value).toBe("for momo");
  });

  it("the same handle on another server is another draft", () => {
    render(<ThreadPane />);
    type("on s1");
    cleanup();
    setZenScope(fakeScope({ id: "s2", username: "baden" }));
    render(<ThreadPane />);
    expect(input().value).toBe("");
  });

  it("a send clears the draft", async () => {
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 5, body: "hello" } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [{ id: "n1", seq: 5, doc: { id: "n1", from: "baden", body: "hello", created_at: 1_700_000_000 } }] },
    });
    const first = render(<ThreadPane />);
    type("hello");
    send();
    expect(input().value).toBe("");
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    first.unmount();
    expect(stored()["s1|t:appa"]).toBeUndefined();
    render(<ThreadPane />);
    expect(input().value).toBe("");
  });

  it("a failed send put back with Edit becomes the draft", async () => {
    vi.mocked(postThread).mockResolvedValue({ ok: false, error: "network" });
    const first = render(<ThreadPane />);
    type("try again");
    send();
    fireEvent.click(await screen.findByTestId("outgoing-restore"));
    expect(input().value).toBe("try again");
    first.unmount();
    expect(stored()["s1|t:appa"].text).toBe("try again");
    render(<ThreadPane />);
    expect(input().value).toBe("try again");
  });

  it("storage that throws does not break typing or switching", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const first = render(<ThreadPane />);
    type("kept in memory");
    expect(input().value).toBe("kept in memory");
    first.unmount();
    render(<ThreadPane />);
    expect(input().value).toBe("kept in memory");
  });
});
