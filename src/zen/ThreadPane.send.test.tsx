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
import {
  FLY_BLUE_AT,
  FLY_BLUE_FROM,
  FLY_CORRECT_MS,
  FLY_MS,
  FLY_TEXT_AT,
  FLY_TEXT_BLUR_PX,
} from "./sendFly";
import { SENDING_OPACITY } from "./useDeliverBrighten";
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

// The bubble's padding as the app's CSS draws it (Tailwind is not loaded
// here): the fly reads it to find the bubble's text origin.
const BUBBLE_PAD_CSS = ".px-3{padding-left:12px;padding-right:12px}.py-2{padding-top:8px;padding-bottom:8px}";

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  openRoom();
  if (!document.getElementById("bubble-pad")) {
    const style = document.createElement("style");
    style.id = "bubble-pad";
    style.textContent = BUBBLE_PAD_CSS;
    document.head.appendChild(style);
  }
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
    expect(bubbles()[0].style.opacity).toBe(String(SENDING_OPACITY));
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
          : id === "composer-field"
            ? { left: 12, top: 692, width: 366, height: 40 }
            : id === "thread-bubble"
              ? { left: 200, top: 500, width: 80, height: 36 }
              : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
  }

  it("flies from the whole composer field pill to the bubble, then reveals the bubble", () => {
    stubGeometry();
    vi.stubGlobal("CSS", { supports: () => true });
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
    const clone = screen.getByTestId("send-fly-clone");
    const calls = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
    const ctx = animate.mock.contexts as unknown as Element[];
    // Two transform animations: the text (the clone) and the blue shape.
    const flyIdx = calls.findIndex(([f]) => f[0].transform != null);
    expect(ctx[flyIdx]).toBe(clone);
    expect(calls.filter(([f]) => f[0].transform != null)).toHaveLength(2);
    const [frames, timing] = calls[flyIdx];
    // Bubble text origin (200+12, 500+8) onto the composer's (20, 700).
    expect(frames[0].transform).toBe("translate3d(-192px, 192px, 0px) scale(1)");
    expect(frames[frames.length - 1].transform).toBe("translate3d(0px, 0px, 0px) scale(1)");
    expect(timing.duration).toBe(FLY_MS);
    // iMessage: ~0.42s from tap to settled.
    expect(FLY_MS).toBe(420);
    // The blue is its own layer (the shape), not part of the text clone.
    expect(clone.querySelector('[data-fly-part="backdrop"]')).toBeNull();
    const shape = screen.getByTestId("send-fly-shape");
    const fill = shape.querySelector('[data-fly-part="backdrop"]')!;
    // Frame 1 is the whole field pill (12,692 366×40, radius 20), faint:
    // the box is anchored at the bubble's bottom-right (280,536), the
    // translate puts that corner on the field's (378,732), the clip leaves
    // the field's size with its own round ends.
    expect(shape.style.left).toBe(`${280 - 366}px`);
    expect(shape.style.top).toBe(`${536 - 40}px`);
    expect(shape.style.width).toBe("366px");
    const move = calls[ctx.indexOf(shape)][0];
    expect(move[0].transform).toBe("translate3d(98px, 196px, 0px)");
    expect(move[move.length - 1].transform).toBe("translate3d(0px, 0px, 0px)");
    const clip = calls[ctx.indexOf(fill)][0];
    expect(clip[0].clipPath).toBe("inset(0px 0px 0px 0px round 20px)");
    expect(clip[clip.length - 1].clipPath).toBe("inset(4px 0px 0px 286px round 18px)");
    expect(calls[ctx.indexOf(fill)][1].duration).toBe(FLY_MS);
    // From a faint tint, solid by blueAt, then the bubble's Sending… opacity.
    const blue = calls.find(([f], i) => ctx[i] === shape && f[0].opacity != null)![0];
    expect(blue.map((k) => k.offset)).toEqual([0, FLY_BLUE_AT, 1]);
    expect(blue.map((k) => k.opacity)).toEqual([FLY_BLUE_FROM, SENDING_OPACITY, SENDING_OPACITY]);
    expect(blue[0].easing).toBe("ease-out");
    expect(FLY_BLUE_FROM).toBeGreaterThan(0);
    expect(shape.style.opacity).toBe(String(FLY_BLUE_FROM));
    // The text re-wraps soft: the field's text blurs out as the bubble's
    // sharpens in, by textAt.
    const ghost = clone.querySelector('[data-fly-part="ghost"]')!;
    const body = clone.querySelector('[data-fly-part="body"]')!;
    const ghostKf = calls[ctx.indexOf(ghost)][0];
    const bodyKf = calls[ctx.indexOf(body)][0];
    expect(ghostKf[0]).toMatchObject({ opacity: 1, filter: "blur(0px)" });
    expect(ghostKf[2]).toMatchObject({ opacity: 0, offset: FLY_TEXT_AT });
    expect(bodyKf[0]).toMatchObject({ opacity: 0, filter: `blur(${FLY_TEXT_BLUR_PX}px)` });
    expect(bodyKf[2]).toMatchObject({ opacity: 1, filter: "blur(0px)", offset: FLY_TEXT_AT });
    // The tail rides the shape (the bubble is the last of its run).
    expect(shape.querySelector('[data-fly-part="tail"]')).not.toBeNull();
    expect(clone.classList.contains("zen-tail")).toBe(false);
    // Compositor-only (plus the shape's clip): no box properties animate.
    for (const [f] of calls) {
      for (const k of f) {
        for (const prop of Object.keys(k)) {
          expect(["transform", "opacity", "filter", "clipPath", "offset", "easing"]).toContain(prop);
        }
      }
    }
    // Above the composer dock (z 2) and its footer blur; under the Zen
    // column's floating header (z 10), like the real bubble.
    expect(Number(clone.style.zIndex)).toBeGreaterThan(
      Number(screen.getByTestId("thread-composer-dock").style.zIndex)
    );
    expect(Number(clone.style.zIndex)).toBeLessThan(10);
    expect(clone.parentElement).toBe(screen.getByTestId("thread-scroller").parentElement);
    expect(Number(shape.style.zIndex)).toBe(Number(clone.style.zIndex));
    expect(shape.parentElement).toBe(clone.parentElement);
    // In flight: the real bubble is laid out but hidden; one clone flies.
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("hidden");
    expect(screen.getAllByTestId("send-fly-clone")).toHaveLength(1);
    act(() => anims[flyIdx].onfinish?.());
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].style.visibility).toBe("");
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
    expect(screen.queryByTestId("send-fly-shape")).toBeNull();
    vi.unstubAllGlobals();
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
    // The brighten is a Web Animation (useDeliverBrighten), not a CSS step.
    expect(bubble.style.transition).toBe("");
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

describe("the takeoff and the landing", () => {
  type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };
  type Call = { el: Element; frames: Keyframe[]; timing: KeyframeAnimationOptions; anim: FakeAnim };
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

  function animateSpy(onCall?: (c: Call) => void) {
    const calls: Call[] = [];
    Element.prototype.animate = vi.fn(function (
      this: Element,
      kf: Keyframe[],
      timing: KeyframeAnimationOptions
    ) {
      const anim: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
      const c = { el: this, frames: kf, timing, anim };
      calls.push(c);
      onCall?.(c);
      return anim;
    }) as never;
    return calls;
  }
  const isClone = (el: Element) => el.getAttribute("data-testid") === "send-fly-clone";
  const flyOf = (calls: Call[]) => calls.find((c) => isClone(c.el) && c.frames[0].transform != null)!;
  const glideOf = (calls: Call[]) =>
    calls.find((c) => c.el.getAttribute("data-testid") === "thread-content");

  /** Geometry: the composer field, the sent bubble (`geo.bubbleTop`), an
   *  older row whose top moves once the new row is in. */
  const geo = { bubbleTop: 500, glided: false, olderBefore: 600, olderAfter: 540 };
  function stubGeometry() {
    geo.bubbleTop = 500;
    geo.glided = false;
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const id = this.getAttribute("data-testid");
      const sentRow = document.querySelector("[data-outgoing]");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble"
            ? // A real browser applies a started glide's first frame to
              // layout reads: model that (+60 while gliding).
              { left: 200, top: geo.bubbleTop + (geo.glided ? 60 : 0), width: 80, height: 36 }
            : this.hasAttribute("data-thread-msg") && !this.hasAttribute("data-outgoing")
              ? { left: 10, top: sentRow ? geo.olderAfter : geo.olderBefore, width: 200, height: 40 }
              : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
  }
  function withOlderRow() {
    openRoom({
      thread: [
        { id: "a1", seq: 1, text: "hi there", from: "appa", at: 1, mine: false, kind: "text", choice: null },
      ],
    });
  }
  function tallScroller() {
    Object.defineProperty(screen.getByTestId("thread-scroller"), "clientHeight", {
      configurable: true,
      value: 700,
    });
  }

  it("no per-frame tracking: after takeoff nothing reads the bubble's rect or writes the clone's box", () => {
    const rects = stubGeometry();
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    const clone = screen.getByTestId("send-fly-clone");
    const box = clone.getAttribute("style");
    const reads = () =>
      rects.mock.contexts.filter((el) => (el as HTMLElement).getAttribute("data-testid") === "thread-bubble").length;
    // Takeoff: the resting rect is read once.
    expect(reads()).toBe(1);
    // The list moves under it mid-flight; frames go by.
    geo.bubbleTop = 470;
    act(() => {
      for (let i = 0; i < 10; i++) runFrames();
    });
    expect(reads()).toBe(1);
    expect(clone.getAttribute("style")).toBe(box);
    expect(clone.style.top).toBe("500px");
    // Landing: one more read (the end correction check), then nothing.
    act(() => flyOf(calls).anim.onfinish?.());
    expect(reads()).toBe(2);
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });

  it("aims at the bubble's glide-free resting rect; the glide and the fly share one curve", () => {
    stubGeometry();
    geo.olderBefore = 600;
    geo.olderAfter = 540;
    withOlderRow();
    const calls = animateSpy((c) => {
      if (c.el.getAttribute("data-testid") === "thread-content") geo.glided = true;
    });
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    tallScroller();
    type("hello");
    send();
    const glide = glideOf(calls)!;
    const fly = flyOf(calls);
    expect(glide).toBeDefined();
    // Measured before the glide started: 500, not 560.
    expect(screen.getByTestId("send-fly-clone").style.top).toBe("500px");
    expect(fly.frames[0].transform).toBe("translate3d(-192px, 192px, 0px) scale(1)");
    // The list starts where it was (60px lower) and glides home.
    expect(glide.frames[0].transform).toBe("translate3d(0px, 60px, 0px)");
    expect(glide.frames[glide.frames.length - 1].transform).toBe("translate3d(0px, 0px, 0px)");
    expect(screen.getByTestId("thread-content").style.willChange).toBe("transform");
    // Same duration, easing and keyframe times: they arrive together.
    expect(glide.timing.duration).toBe(fly.timing.duration);
    expect(glide.timing.easing).toBe(fly.timing.easing);
    expect(glide.frames.map((k) => k.offset)).toEqual(fly.frames.map((k) => k.offset));
    // Same progress at every keyframe (the same ~2px settle, never more).
    const glideP = glide.frames.map((k) => 1 - parseFloat(/, ([-\d.]+)px/.exec(String(k.transform))![1]) / 60);
    const flyP = fly.frames.map((k) => 1 - parseFloat(/, ([-\d.]+)px/.exec(String(k.transform))![1]) / 192);
    glideP.forEach((p, i) => expect(p).toBeCloseTo(flyP[i], 2));
    glideP.forEach((p) => expect(p).toBeLessThanOrEqual(1.01));
    // Started in the same frame, after the clone was placed.
    expect(calls.indexOf(glide)).toBeLessThan(calls.indexOf(fly));
    expect(calls.slice(0, calls.indexOf(glide)).some((c) => isClone(c.el))).toBe(false);
    // will-change only while it runs.
    act(() => glide.anim.onfinish?.());
    expect(screen.getByTestId("thread-content").style.willChange).toBe("");
  });

  it("a multi-line composer that shrank more than the row took: the list glides down instead of jumping", () => {
    stubGeometry();
    geo.olderBefore = 600;
    geo.olderAfter = 640;
    withOlderRow();
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    tallScroller();
    type("one\ntwo\nthree");
    send();
    expect(glideOf(calls)!.frames[0].transform).toBe("translate3d(0px, -40px, 0px)");
  });

  it("same-frame hand-off: the field clears in the very commit the clone mounts, on the composer's text", () => {
    stubGeometry();
    let commits = 0;
    let clearedAt = -1;
    let flewAt = -1;
    let seen: { value: string; ghost: string | null; hidden: string | undefined } | null = null;
    animateSpy((c) => {
      if (!isClone(c.el) || c.frames[0].transform == null) return;
      flewAt = commits;
      seen = {
        value: input().value,
        ghost: c.el.querySelector('[data-fly-part="ghost"]')?.textContent ?? null,
        hidden: bubbles()[0]?.style.visibility,
      };
    });
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(
      <Profiler id="pane" onRender={() => commits++}>
        <ThreadPane />
      </Profiler>
    );
    type("hello");
    const field = input();
    // The field's text box: inside its padding.
    field.style.paddingTop = "4px";
    field.style.paddingLeft = "8px";
    field.style.color = "rgb(228, 228, 231)";
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
    Object.defineProperty(field, "value", {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: string) {
        if (v === "" && clearedAt < 0) clearedAt = commits;
        proto.set!.call(this, v);
      },
    });
    send();
    expect(seen).toEqual({ value: "", ghost: "hello", hidden: "hidden" });
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    expect(flewAt).toBe(clearedAt);
    // Frame 0 is the composer text: its origin (20+8, 700+4), its colour.
    const clone = screen.getByTestId("send-fly-clone");
    const ghostText = clone.querySelector<HTMLElement>('[data-fly-part="ghost"] > div')!;
    expect(ghostText.style.color).toBe("rgb(228, 228, 231)");
    expect(ghostText.style.whiteSpace).not.toBe("");
    const ghost = clone.querySelector<HTMLElement>('[data-fly-part="ghost"]')!;
    expect(ghost.style.left).toBe("12px");
    expect(ghost.style.top).toBe("8px");
    const calls = (Element.prototype.animate as unknown as { mock: { calls: [Keyframe[]][]; contexts: Element[] } }).mock;
    const i = calls.contexts.findIndex((el, n) => isClone(el) && calls.calls[n][0][0].transform != null);
    expect(calls.calls[i][0][0].transform).toBe("translate3d(-184px, 196px, 0px) scale(1)");
    // The composer's look hands over to the bubble's text in a few frames.
    const body = clone.querySelector('[data-fly-part="body"]')!;
    const bodyFade = calls.calls[calls.contexts.indexOf(body)][0];
    expect(bodyFade[0].opacity).toBe(0);
    expect(Number(bodyFade[1].offset)).toBeLessThanOrEqual(0.2);
    field.removeAttribute("style");
    delete (field as unknown as { value?: string }).value;
  });

  it("lands without a correction when the bubble stayed put", () => {
    stubGeometry();
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    act(() => flyOf(calls).anim.onfinish?.());
    expect(calls.filter((c) => c.el === bubble)).toHaveLength(0);
    expect(bubble.style.visibility).toBe("");
  });

  it("the bubble moved mid-flight (the drawer opened): one short slide from where the clone sat", () => {
    stubGeometry();
    const calls = animateSpy();
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    render(<ThreadPane />);
    type("hello");
    send();
    const bubble = bubbles()[0];
    geo.bubbleTop = 470;
    act(() => flyOf(calls).anim.onfinish?.());
    const fix = calls.filter((c) => c.el === bubble);
    expect(fix).toHaveLength(1);
    expect(fix[0].frames.map((k) => k.transform)).toEqual([
      "translate3d(0px, 30px, 0px)",
      "translate3d(0px, 0px, 0px)",
    ]);
    expect(fix[0].timing.duration).toBe(FLY_CORRECT_MS);
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });

  it("delivered mid-flight: no polling; it brightens from the clone's dim after the reveal", async () => {
    stubGeometry();
    const calls = animateSpy();
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 5 } });
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    const clone = screen.getByTestId("send-fly-clone");
    // The clone dims to the "Sending…" bubble with the blue.
    const dim = calls.find((c) => c.el === clone && c.frames[0].opacity != null)!;
    expect(dim.frames.map((k) => k.opacity)).toEqual([1, SENDING_OPACITY, SENDING_OPACITY]);
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    const bubble = bubbles()[0];
    expect(bubble.style.opacity).toBe("1");
    act(() => flyOf(calls).anim.onfinish?.());
    const brighten = calls.filter((c) => c.el === bubble);
    expect(brighten).toHaveLength(1);
    expect(brighten[0].frames).toEqual([{ opacity: SENDING_OPACITY }, { opacity: 1 }]);
  });

  it("sending after it lands: a gentle breathe (not while flying), gone once delivered", async () => {
    stubGeometry();
    const calls = animateSpy();
    const post = deferred<{ ok: boolean; data: { id: string; seq: number } }>();
    vi.mocked(postThread).mockReturnValue(post.promise as never);
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wireItem("n1", 5, "hello")] },
    });
    render(<ThreadPane />);
    type("hello");
    send();
    expect(bubbles()[0].className).not.toContain("zen-bubble-breathe");
    act(() => flyOf(calls).anim.onfinish?.());
    expect(bubbles()[0].className).toContain("zen-bubble-breathe");
    await act(async () => post.resolve({ ok: true, data: { id: "n1", seq: 5 } }));
    await waitFor(() => expect(bubbles()[0].className).not.toContain("zen-bubble-breathe"));
    expect(bubbles()[0].style.opacity).toBe("1");
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
      // The stash tab's 18px over the scroller (32px tall, 14px of it on the bar).
      expect(scroller.style.paddingBottom).toBe(threadBottomPadding(44, 18));
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
