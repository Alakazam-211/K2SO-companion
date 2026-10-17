// @vitest-environment jsdom
// Optimistic send (iMessage): the field clears on tap, a "Sending…" bubble
// shows at once, the server's copy replaces it (one bubble, echo or not),
// a failure stays "Not sent" with retry, and the text flies into its bubble.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    uploadFsBinary: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
vi.mock("../api/projectGroups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/projectGroups")>();
  return { ...actual, postProjectGroupMessage: vi.fn() };
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

import { getThread, postThread, uploadFsBinary } from "../api/client";
import { postProjectGroupMessage } from "../api/projectGroups";
import { ThreadPane, threadBottomPadding } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { RECENT_SENT_KEY, useRecentFirstStore } from "./recentFirst";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise, resolve };
}

const wireItem = (id: string, seq: number, body: string, from = "baden") => ({
  id,
  seq,
  doc: { id, from, body, created_at: 1_700_000_000 },
});

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: null,
    agentId: "appa",
    agents: [
      { id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" },
    ],
    thread: [],
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
    ...over,
  });
}

const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
const bubbles = () => screen.queryAllByTestId("thread-bubble");
function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}
function send() {
  fireEvent.submit(screen.getByTestId("composer-form"));
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  openRoom();
});

afterEach(() => {
  cleanup();
  vi.mocked(postThread).mockReset();
  vi.mocked(getThread).mockReset();
  vi.mocked(uploadFsBinary).mockReset();
  vi.mocked(postProjectGroupMessage).mockReset();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete Element.prototype.animate;
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("optimistic send", () => {
  it("clears the field synchronously and shows a Sending… bubble before the POST answers", async () => {
    const post = deferred<Awaited<ReturnType<typeof postThread>>>();
    vi.mocked(postThread).mockReturnValue(post.promise);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    input().focus();
    type("hello");
    send();
    // Before any await: empty, still focused (keyboard stays up), not disabled.
    expect(input().value).toBe("");
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].textContent).toContain("hello");
    expect(bubbles()[0].style.opacity).toBe("0.7");
    expect(screen.getByText("Sending…")).not.toBeNull();
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5, body: "hello" } }));
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.opacity).toBe("1");
    expect(useZenStore.getState().outbox).toEqual([]);
  });

  it("a socket echo before the POST answers is still one bubble", async () => {
    const post = deferred<Awaited<ReturnType<typeof postThread>>>();
    vi.mocked(postThread).mockReturnValue(post.promise);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    act(() => useZenStore.getState().ingestThreadRaw(wireItem("n1", 5, "hello")));
    expect(bubbles()).toHaveLength(1);
    expect(screen.queryByText("Sending…")).toBeNull();
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5, body: "hello" } }));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()).toHaveLength(1);
  });

  it("a socket echo after the POST answers is still one bubble", async () => {
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 5, body: "hello" } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    act(() => useZenStore.getState().ingestThreadRaw(wireItem("n1", 5, "hello")));
    expect(bubbles()).toHaveLength(1);
  });

  it("an older identical message does not swallow the new bubble", () => {
    openRoom({
      thread: [
        { id: "old", seq: 1, text: "ok", from: "baden", at: 1, mine: true, kind: "text", choice: null },
      ],
    });
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("ok");
    send();
    expect(bubbles()).toHaveLength(2);
    expect(screen.getByText("Sending…")).not.toBeNull();
  });

  it("a failed send stays as Not sent; retry delivers it; nothing is lost", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "tunnel down" });
    render(<ThreadPane />);
    type("hello");
    send();
    expect(input().value).toBe("");
    await screen.findByTestId("outgoing-retry");
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].textContent).toContain("hello");
    expect(screen.getByTestId("composer-label").textContent).toBe("tunnel down");
    vi.mocked(postThread).mockResolvedValueOnce({ ok: true, data: { id: "n1", seq: 5, body: "hello" } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    fireEvent.click(screen.getByTestId("outgoing-retry"));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(postThread).toHaveBeenCalledTimes(2);
    expect(vi.mocked(postThread).mock.calls[1][2]).toBe("hello");
    expect(bubbles()).toHaveLength(1);
    expect(screen.queryByTestId("outgoing-retry")).toBeNull();
  });

  it("Edit puts a Not sent message back into an empty composer", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "tunnel down" });
    render(<ThreadPane />);
    type("hello there");
    send();
    fireEvent.click(await screen.findByTestId("outgoing-restore"));
    expect(input().value).toBe("hello there");
    expect(bubbles()).toHaveLength(0);
    expect(useZenStore.getState().outbox).toEqual([]);
  });

  it("Edit is not offered while the composer has a new draft", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "tunnel down" });
    render(<ThreadPane />);
    type("hello");
    send();
    await screen.findByTestId("outgoing-retry");
    type("something else");
    expect(screen.queryByTestId("outgoing-restore")).toBeNull();
  });

  it("guards a double send while one is in flight, but typing stays open", () => {
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("one");
    send();
    send();
    type("two");
    expect(input().value).toBe("two");
    expect(screen.getByTestId("composer-send")).toHaveProperty("disabled", true);
    send();
    expect(postThread).toHaveBeenCalledTimes(1);
    expect(bubbles()).toHaveLength(1);
    expect(input().value).toBe("two");
  });

  it("attachments: chips clear at once, the bubble names them, an upload failure is Not sent and retry re-uploads", async () => {
    const upload = deferred<Awaited<ReturnType<typeof uploadFsBinary>>>();
    vi.mocked(uploadFsBinary).mockReturnValueOnce(upload.promise);
    render(<ThreadPane />);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: { files: [file], items: [] },
    });
    type("look");
    send();
    expect(screen.queryByTestId("attach-chip")).toBeNull();
    expect(input().value).toBe("");
    expect(screen.getByTestId("bubble-attachment").textContent).toBe("shot.png");
    expect(bubbles()[0].textContent).toContain("look");
    expect(screen.getByText("Sending…")).not.toBeNull();
    await act(async () => upload.resolve({ ok: false, error: "disk full" }));
    await screen.findByTestId("outgoing-retry");
    expect(postThread).not.toHaveBeenCalled();
    vi.mocked(uploadFsBinary).mockResolvedValueOnce({
      ok: true,
      data: { path: "/Users/Baden/Appa/.k2/downloads/shot.png" },
    });
    vi.mocked(postThread).mockResolvedValueOnce({ ok: true, data: { id: "n2", seq: 6 } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n2", 6, "look /Users/Baden/Appa/.k2/downloads/shot.png")] },
    });
    fireEvent.click(screen.getByTestId("outgoing-retry"));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(uploadFsBinary).toHaveBeenCalledTimes(2);
    expect(vi.mocked(postThread).mock.calls[0][2]).toBe("look /Users/Baden/Appa/.k2/downloads/shot.png");
    expect(bubbles()).toHaveLength(1);
  });

  it("project chats send optimistically too", async () => {
    openRoom({
      agentId: "group:pg1",
      agents: [
        { id: "group:pg1", name: "K2", initial: "K", kind: "group", groupId: "pg1", memberCount: 2, addr: null, joinMiss: null },
      ],
      threadAddr: null,
      threadGroupId: "pg1",
    });
    const post = deferred<Awaited<ReturnType<typeof postProjectGroupMessage>>>();
    vi.mocked(postProjectGroupMessage).mockReturnValue(post.promise);
    render(<ThreadPane />);
    type("team");
    send();
    expect(input().value).toBe("");
    expect(screen.getByText("Sending…")).not.toBeNull();
    await act(async () =>
      post.resolve({
        ok: true,
        data: {
          id: "m1",
          groupId: "pg1",
          author: "baden",
          body: "team",
          createdAt: 1_700_000_000,
          delivered: true,
          deliveryReason: null,
          deliveredSessionId: null,
        },
      })
    );
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(bubbles()).toHaveLength(1);
  });
});

describe("send animation (FLIP)", () => {
  type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };
  function stubGeometry() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const id = this.getAttribute("data-testid");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble"
            ? { left: 200, top: 500, width: 80, height: 36 }
            : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
  }

  it("flies a clone from the composer rect to the bubble rect, then reveals the bubble", () => {
    stubGeometry();
    const anims: FakeAnim[] = [];
    const animate = vi.fn(() => {
      const a: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
      anims.push(a);
      return a;
    });
    Element.prototype.animate = animate as never;
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    // Bubble text origin (200+12, 500+8) onto the composer's (20, 700).
    expect(frames[0].transform).toBe("translate(-192px, 192px) scale(1.000)");
    expect(frames[1].transform).toBe("translate(0px, 0px) scale(1)");
    expect(frames[1].backgroundColor).toBe("rgb(10, 132, 255)");
    expect(timing.duration).toBeGreaterThanOrEqual(300);
    expect(timing.duration).toBeLessThanOrEqual(380);
    // In flight: the real bubble is laid out but hidden; one clone flies.
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("hidden");
    expect(screen.getAllByTestId("send-fly-clone")).toHaveLength(1);
    act(() => anims[0].onfinish?.());
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("");
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });

  it("reduced motion: no animate(), the bubble just fades in", () => {
    stubGeometry();
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as never;
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    expect(animate).not.toHaveBeenCalled();
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("");
    expect(bubbles()[0].className).toContain("zen-bubble-fade");
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });

  it("a confirmation mid-flight keeps one (hidden) bubble, revealed when it lands", async () => {
    stubGeometry();
    const anims: FakeAnim[] = [];
    Element.prototype.animate = vi.fn(() => {
      const a: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
      anims.push(a);
      return a;
    }) as never;
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 5 } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("hidden");
    act(() => anims[0].onfinish?.());
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("");
  });
});

describe("one element from Send to delivered (no snap, no jostle)", () => {
  const row = (el: HTMLElement) => el.closest("[data-thread-msg]") as HTMLElement;
  const line = (el: HTMLElement) =>
    row(el).querySelector('[data-testid="thread-msg-time"]') as HTMLElement;

  it("the landed message is the same row, bubble and status line as the optimistic one", async () => {
    const post = deferred<Awaited<ReturnType<typeof postThread>>>();
    vi.mocked(postThread).mockReturnValue(post.promise);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    const r = row(bubble);
    const l = line(bubble);
    expect(l.textContent).toBe("Sending…");
    expect(l.dataset.status).toBe("sending");
    const lineClass = l.className;
    const rowClass = r.className;
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5, body: "hello" } }));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    // Same DOM nodes: React kept the key (no remount, nothing re-laid out).
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]).toBe(bubble);
    expect(row(bubbles()[0])).toBe(r);
    expect(line(bubbles()[0])).toBe(l);
    // Only the words in the fixed-height line and the opacity changed.
    expect(l.className).toBe(lineClass);
    expect(l.className).toContain("h-4");
    expect(r.className).toBe(rowClass);
    expect(l.textContent).not.toBe("Sending…");
    expect(l.dataset.status).toBe("sent");
    expect(bubble.style.opacity).toBe("1");
    expect(bubble.style.transition).toContain("opacity");
    expect(r.hasAttribute("data-outgoing")).toBe(false);
  });

  it("a socket echo before the POST answers keeps the same element too", async () => {
    const post = deferred<Awaited<ReturnType<typeof postThread>>>();
    vi.mocked(postThread).mockReturnValue(post.promise);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    act(() => useZenStore.getState().ingestThreadRaw(wireItem("n1", 5, "hello")));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]).toBe(bubble);
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5, body: "hello" } }));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()[0]).toBe(bubble);
    expect(useZenStore.getState().landedKeys).toEqual({
      ["s1|t:appa\nn1"]: expect.stringMatching(/^local-/),
    });
  });

  it("a project chat keeps the same element when the post answers", async () => {
    openRoom({
      agentId: "group:pg1",
      agents: [
        { id: "group:pg1", name: "K2", initial: "K", kind: "group", groupId: "pg1", memberCount: 2, addr: null, joinMiss: null },
      ],
      threadAddr: null,
      threadGroupId: "pg1",
    });
    const post = deferred<Awaited<ReturnType<typeof postProjectGroupMessage>>>();
    vi.mocked(postProjectGroupMessage).mockReturnValue(post.promise);
    render(<ThreadPane />);
    type("team");
    send();
    const bubble = bubbles()[0];
    await act(async () =>
      post.resolve({
        ok: true,
        data: {
          id: "m1",
          groupId: "pg1",
          author: "baden",
          body: "team",
          createdAt: 1_700_000_000,
          delivered: true,
          deliveryReason: null,
          deliveredSessionId: null,
        },
      })
    );
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]).toBe(bubble);
  });

  it("no commit ever shows the send twice or not at all", async () => {
    const post = deferred<Awaited<ReturnType<typeof postThread>>>();
    vi.mocked(postThread).mockReturnValue(post.promise);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    const commits: { count: number; first: Element | null }[] = [];
    let sent = false;
    render(
      <Profiler
        id="thread"
        onRender={() => {
          if (!sent) return;
          const all = document.querySelectorAll('[data-testid="thread-bubble"]');
          commits.push({ count: all.length, first: all[0] ?? null });
        }}
      >
        <ThreadPane />
      </Profiler>
    );
    type("hello");
    sent = true;
    send();
    act(() => useZenStore.getState().ingestThreadRaw(wireItem("n1", 5, "hello")));
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5, body: "hello" } }));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(commits.length).toBeGreaterThan(2);
    expect(commits.every((c) => c.count === 1)).toBe(true);
    expect(new Set(commits.map((c) => c.first)).size).toBe(1);
  });

  it("a failed send keeps the same line box; the retry lands in the same element", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "tunnel down" });
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    const l = line(bubble);
    await screen.findByTestId("outgoing-retry");
    expect(line(bubbles()[0])).toBe(l);
    expect(l.dataset.status).toBe("failed");
    expect(l.contains(screen.getByTestId("outgoing-failed"))).toBe(true);
    vi.mocked(postThread).mockResolvedValueOnce({ ok: true, data: { id: "n1", seq: 5, body: "hello" } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    fireEvent.click(screen.getByTestId("outgoing-retry"));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()[0]).toBe(bubble);
    expect(line(bubble)).toBe(l);
    expect(l.dataset.status).toBe("sent");
  });

  it("reduced motion: no fly, the bubble just appears, and landing keeps it", async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as never;
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 5 } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    expect(bubble.style.visibility).toBe("");
    expect(bubble.className).toContain("zen-bubble-fade");
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(bubbles()[0]).toBe(bubble);
    expect(animate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });
});

describe("the fly lands exactly on the bubble", () => {
  type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };
  let frames: FrameRequestCallback[] = [];
  function runFrames() {
    const now = frames;
    frames = [];
    now.forEach((f) => f(0));
  }
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  function animateSpy() {
    const calls: { el: Element; frames: Keyframe[]; anim: FakeAnim }[] = [];
    Element.prototype.animate = vi.fn(function (this: Element, kf: Keyframe[]) {
      const anim: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
      calls.push({ el: this, frames: kf, anim });
      return anim;
    }) as never;
    return calls;
  }

  it("the clone follows the real bubble when the list moves mid-flight", () => {
    const bubbleRect = { left: 200, top: 500, width: 80, height: 36 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const id = this.getAttribute("data-testid");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble"
            ? bubbleRect
            : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    const clone = screen.getByTestId("send-fly-clone");
    expect(clone.style.top).toBe("500px");
    // The composer / working drawer moves the list 30px up mid-flight.
    bubbleRect.top = 470;
    act(() => runFrames());
    expect(clone.style.top).toBe("470px");
    expect(clone.style.left).toBe("200px");
    // Hand-off: the bubble is shown in the same step the clone goes.
    const fly = calls.find((c) => c.el === clone)!;
    fly.anim.onfinish?.();
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
    expect(bubbles()[0].style.visibility).toBe("");
  });

  it("the list glides up by the room the new row took, instead of jumping", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const id = this.getAttribute("data-testid");
      const sentRow = document.querySelector("[data-outgoing]");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble"
            ? { left: 200, top: 560, width: 80, height: 36 }
            : this.hasAttribute("data-thread-msg") && !this.hasAttribute("data-outgoing")
              ? { left: 10, top: sentRow ? 540 : 600, width: 200, height: 40 }
              : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
    openRoom({
      thread: [
        { id: "a1", seq: 1, text: "hi there", from: "appa", at: 1, mine: false, kind: "text", choice: null },
      ],
    });
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    Object.defineProperty(screen.getByTestId("thread-scroller"), "clientHeight", {
      configurable: true,
      value: 700,
    });
    type("hello");
    send();
    const glide = calls.find((c) => c.el === screen.getByTestId("thread-content"));
    expect(glide).toBeDefined();
    expect(glide!.frames[0].transform).toBe("translateY(60px)");
    expect(glide!.frames[1].transform).toBe("translateY(0px)");
    expect(calls.filter((c) => c.el.getAttribute("data-testid") === "send-fly-clone")).toHaveLength(1);
  });

  it("the composer's shrink is applied before the bubble is aimed (no ease under it)", () => {
    let barPx = 88;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === "composer-bar" ? barPx : 0;
      },
    });
    try {
      vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
      render(<ThreadPane />);
      const scroller = screen.getByTestId("thread-scroller");
      expect(scroller.dataset.composerHeight).toBe("88");
      type("one\ntwo\nthree");
      barPx = 44;
      send();
      // No ResizeObserver in jsdom: only the send itself picked up 44.
      expect(scroller.dataset.composerHeight).toBe("44");
      expect(scroller.style.paddingBottom).toBe(threadBottomPadding(44, 0));
      expect(scroller.style.transition).toBe("");
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
  });
});

describe("Recent agents first: the send is recorded on this phone", () => {
  beforeEach(() => {
    localStorage.clear();
    useRecentFirstStore.getState().reload();
  });

  it("a send stamps <server>|t:<addr>, stored locally, setting on or off", () => {
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    expect(useRecentFirstStore.getState().on).toBe(false);
    render(<ThreadPane />);
    type("hi");
    send();
    expect(useRecentFirstStore.getState().sent).toEqual({ "s1|t:appa": 1_234 });
    expect(JSON.parse(localStorage.getItem(RECENT_SENT_KEY) || "{}")).toEqual({ "s1|t:appa": 1_234 });
  });

  it("an empty composer records nothing; a project chat is not recorded", () => {
    vi.mocked(postProjectGroupMessage).mockReturnValue(new Promise(() => {}));
    openRoom({
      agentId: "group:pg1",
      agents: [
        { id: "group:pg1", name: "K2", initial: "K", kind: "group", groupId: "pg1", memberCount: 2, addr: null, joinMiss: null },
      ],
      threadAddr: null,
      threadGroupId: "pg1",
    });
    render(<ThreadPane />);
    send();
    type("team");
    send();
    expect(screen.getByText("Sending…")).not.toBeNull();
    expect(useRecentFirstStore.getState().sent).toEqual({});
  });
});
