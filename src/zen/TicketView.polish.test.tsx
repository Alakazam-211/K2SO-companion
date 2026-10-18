// @vitest-environment jsdom
// The open ticket gets the Thread's polish: the short send pill that keeps
// the keyboard up, the floating composer on the footer blur, the
// optimistic comment that flies in and only brightens on delivery, the
// "New comment ↓" pill and a draft per ticket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(async () => ({ ok: true, data: [{ name: "Skin", path: "/tmp/skin" }] })),
}));

vi.mock("../api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/feedback")>();
  return {
    ...actual,
    resolveFeedback: vi.fn(async () => undefined),
    commentFeedback: vi.fn(),
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner", "u"]),
    assignFeedback: vi.fn(async () => ({ assignees: [] })),
  };
});

vi.mock("./ticketEvents", () => ({
  connectTicketEvents: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../lib/useSessionIdentity", () => {
  const me = { username: "u", owner: false };
  return { useSessionIdentity: () => me };
});

import {
  commentFeedback,
  fetchFeedbackShow,
  type CommentResponse,
  type FeedbackComment,
  type FeedbackShow,
} from "../api/feedback";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { composerDraftKey, ticketDraftKey, useComposerDrafts } from "./composerDrafts";
import { TicketView } from "./TicketView";

const NOW = Math.floor(Date.now() / 1000);

const BASE: FeedbackShow = {
  id: "t-wait",
  projectId: "p1",
  sessionId: null,
  sessionKind: null,
  agentName: "sales",
  kind: "question",
  title: "Which pricing tier for Acme?",
  body: "One-line summary",
  options: ["Pro", "Business"],
  priority: 2,
  status: "waiting",
  answer: null,
  createdAt: NOW - 120,
  updatedAt: NOW - 120,
  answeredAt: null,
  commentCount: 2,
  assignees: ["u"],
  hasBrief: false,
  workspace: "Skin",
  projectPath: "/tmp/skin",
  comments: [
    { author: "sales", body: "Filed. Brief attached.", at: NOW - 120 },
    { author: "u", body: "Looking now", at: NOW - 60 },
  ],
};

/** What the server's `show` answers right now. */
let served: FeedbackShow = BASE;
function withComments(...extra: FeedbackComment[]): FeedbackShow {
  return { ...BASE, comments: [...BASE.comments, ...extra] };
}

const OK: CommentResponse = { ok: true, id: "t-wait", commentId: "c9", author: "u", delivered: true };

function open(id = "t-wait", item: FeedbackShow = BASE, linked = true) {
  useFeedbackStore.setState({ openId: id, openItem: { ...item, id } });
  return render(
    <div style={{ position: "relative", height: 800 }}>
      <TicketView id={id} linked={linked} onBack={() => {}} />
    </div>
  );
}

const input = () => screen.getByTestId("ticket-composer-input") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const send = () => fireEvent.submit(screen.getByTestId("ticket-composer-form"));
const rows = () => screen.getAllByTestId("ticket-comment");
const last = () => rows()[rows().length - 1];
const bubbleOf = (row: HTMLElement) => within(row).getByTestId("ticket-bubble");
const statusOf = (row: HTMLElement) => within(row).getByTestId("ticket-comment-status");

/** commentFeedback answers when the test says so. */
function deferPost() {
  let answer: (r: CommentResponse) => void = () => {};
  let fail: (e: Error) => void = () => {};
  vi.mocked(commentFeedback).mockImplementationOnce(
    () =>
      new Promise<CommentResponse>((res, rej) => {
        answer = res;
        fail = rej;
      })
  );
  return { answer: (r: CommentResponse) => answer(r), fail: (e: Error) => fail(e) };
}

type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };

function stubGeometry() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute("data-testid");
    const r =
      id === "ticket-composer-input"
        ? { left: 20, top: 700, width: 300, height: 24 }
        : id === "ticket-bubble"
          ? { left: 200, top: 500, width: 80, height: 36 }
          : { left: 0, top: 0, width: 390, height: 844 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
}

function reducedMotion() {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as never;
}

// The paddings as the app's CSS draws them (Tailwind is not loaded here):
// the fly starts on the field's text box and ends on the bubble's.
const PAD_CSS =
  ".px-3{padding-left:12px;padding-right:12px}.py-2{padding-top:8px;padding-bottom:8px}" +
  ".px-2{padding-left:8px;padding-right:8px}.py-1{padding-top:4px;padding-bottom:4px}";

beforeEach(() => {
  if (!document.getElementById("pad-css")) {
    const style = document.createElement("style");
    style.id = "pad-css";
    style.textContent = PAD_CSS;
    document.head.appendChild(style);
  }
  vi.clearAllMocks();
  localStorage.clear();
  useComposerDrafts.getState().reload();
  served = BASE;
  vi.mocked(fetchFeedbackShow).mockImplementation(async () => served);
  vi.mocked(commentFeedback).mockResolvedValue(OK);
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useFeedbackStore.setState({
    rows: [],
    waitingCount: 0,
    isLoading: false,
    error: null,
    loadedForServer: "s1",
    openId: null,
    openItem: null,
    openError: null,
    briefs: {},
    commentOutbox: [],
    commentLandedKeys: {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error jsdom has none; a test may have added one.
  delete Element.prototype.animate;
  // @ts-expect-error same
  delete window.matchMedia;
});

describe("Ticket composer — the Thread's GlassComposer", () => {
  it("sends with the short pill (38×30, radius 15), blue once there is text; no +", () => {
    open();
    const sendBtn = screen.getByTestId("ticket-composer-send");
    expect(sendBtn.style.width).toBe("38px");
    expect(sendBtn.style.height).toBe("30px");
    expect(sendBtn.style.borderRadius).toBe("15px");
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
    type("Let's talk");
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
    expect(sendBtn.style.background).toBe("rgb(10, 132, 255)");
    // A comment is text only: no attach button on a ticket.
    expect(screen.queryByTestId("ticket-composer-attach")).toBeNull();
  });

  it("keeps the keyboard up: Send never takes focus from the field, and focus stays after sending", () => {
    vi.mocked(commentFeedback).mockReturnValue(new Promise(() => {}));
    open();
    const field = input();
    field.focus();
    type("Ship it");
    const sendBtn = screen.getByTestId("ticket-composer-send");
    for (const kind of ["pointerDown", "mouseDown"] as const) {
      const ev = createEvent[kind](sendBtn);
      fireEvent(sendBtn, ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    send();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("");
  });
});

describe("Ticket composer floats over the comments on the footer blur", () => {
  it("the dock floats at the bottom on the blur; the scroller pads by its height plus 12px", () => {
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "ticket-footer-dock" ? 90 : 0;
      },
    });
    try {
      open();
      const dock = screen.getByTestId("ticket-footer-dock");
      expect(dock.className).toContain("absolute");
      expect(dock.className).toContain("bottom-0");
      // The composer bar keeps the home-indicator inset (--safe-bottom),
      // collapsing to the 8px keyboard gap while typing.
      const bar = screen.getByTestId("ticket-composer-bar");
      expect(dock.contains(bar)).toBe(true);
      expect(bar.className).toContain("zen-composer-bar");
      const blur = screen.getByTestId("ticket-footer-blur");
      expect(blur.className).toBe("zen-footer-blur");
      expect(blur.getAttribute("aria-hidden")).toBe("true");
      expect(blur.parentElement).toBe(dock);
      expect(blur.style.top).toBe("-24px");
      expect(blur.style.bottom).toBe("0px");
      const scroller = screen.getByTestId("ticket-scroller");
      expect(scroller.contains(dock)).toBe(false);
      expect(scroller.getAttribute("data-bottom-inset")).toBe("90");
      expect(scroller.style.paddingBottom).toBe(`${12 + 90}px`);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", real);
    }
  });

  it("an unlinked ticket's Resolve / Dismiss footer floats the same way, clearing the safe area", () => {
    open("t-wait", BASE, false);
    const dock = screen.getByTestId("ticket-footer-dock");
    const footer = screen.getByTestId("ticket-unlinked-footer");
    expect(dock.contains(footer)).toBe(true);
    expect(footer.style.paddingBottom).toBe("max(10px, var(--safe-bottom))");
    expect(screen.getByTestId("ticket-footer-blur").parentElement).toBe(dock);
    expect(screen.queryByTestId("ticket-composer-bar")).toBeNull();
  });
});

describe("Optimistic comment", () => {
  it("shows at once (dimmed, Sending…), then the server's copy keeps the same element and only brightens", async () => {
    const post = deferPost();
    open();
    expect(rows()).toHaveLength(2);
    type("Ship Pro");
    send();
    expect(commentFeedback).toHaveBeenCalledWith(expect.anything(), "t-wait", "Ship Pro");
    expect(rows()).toHaveLength(3);
    const row = last();
    expect(row.getAttribute("data-mine")).toBe("1");
    expect(row.getAttribute("data-outgoing")).toBe("sending");
    expect(bubbleOf(row).style.opacity).toBe("0.7");
    expect(bubbleOf(row).style.transition).toContain("opacity");
    expect(statusOf(row).textContent).toBe("Sending…");
    // Typing stays open while it sends; a second send waits.
    type("again");
    expect((screen.getByTestId("ticket-composer-send") as HTMLButtonElement).disabled).toBe(true);
    type("");

    served = withComments({ author: "u", body: "Ship Pro", at: NOW });
    await act(async () => {
      post.answer(OK);
    });
    await waitFor(() => expect(last().getAttribute("data-outgoing")).toBeNull());
    expect(rows()).toHaveLength(3);
    // Same element from tap to delivered: no remount.
    expect(last()).toBe(row);
    expect(row.isConnected).toBe(true);
    expect(bubbleOf(row).style.opacity).toBe("1");
    expect(statusOf(row).getAttribute("data-status")).toBe("sent");
    expect(statusOf(row).textContent).not.toBe("Sending…");
    expect(useFeedbackStore.getState().commentOutbox).toHaveLength(0);
    expect(Object.keys(useFeedbackStore.getState().commentLandedKeys)).toHaveLength(1);
  });

  it("a refetch showing the comment before the POST answers keeps the same element too", async () => {
    deferPost();
    open();
    type("Ship Pro");
    send();
    const row = last();
    act(() => {
      useFeedbackStore.setState({ openItem: withComments({ author: "u", body: "Ship Pro", at: NOW }) });
    });
    await waitFor(() => expect(useFeedbackStore.getState().commentOutbox).toHaveLength(0));
    expect(rows()).toHaveLength(3);
    expect(last()).toBe(row);
    expect(bubbleOf(row).style.opacity).toBe("1");
  });

  it("a failure says Not sent · Retry / Edit; Retry resends the same bubble", async () => {
    const first = deferPost();
    open();
    type("Ship Pro");
    send();
    const row = last();
    await act(async () => {
      first.fail(new Error("offline"));
    });
    expect(row.getAttribute("data-outgoing")).toBe("failed");
    expect(screen.getByTestId("comment-retry").textContent).toBe("Not sent · Retry");
    expect(screen.getByTestId("comment-restore").textContent).toBe("Edit");
    expect(screen.getByTestId("ticket-composer-label").textContent).toBe("offline");
    // Edit only while the composer is empty (it would overwrite the text).
    type("something else");
    expect(screen.queryByTestId("comment-restore")).toBeNull();
    type("");

    deferPost();
    fireEvent.click(screen.getByTestId("comment-retry"));
    expect(commentFeedback).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commentFeedback).mock.calls[1][2]).toBe("Ship Pro");
    expect(last()).toBe(row);
    expect(row.getAttribute("data-outgoing")).toBe("sending");
    expect(statusOf(row).textContent).toBe("Sending…");
  });

  it("Edit puts a failed comment back into the composer and the bubble goes", async () => {
    vi.mocked(commentFeedback).mockRejectedValueOnce(new Error("offline"));
    open();
    type("Ship Pro");
    send();
    await waitFor(() => screen.getByTestId("comment-restore"));
    fireEvent.click(screen.getByTestId("comment-restore"));
    expect(input().value).toBe("Ship Pro");
    expect(rows()).toHaveLength(2);
    expect(useFeedbackStore.getState().commentOutbox).toHaveLength(0);
  });

  it("flies a clone from the composer into the hidden bubble, then reveals it", () => {
    stubGeometry();
    const anims: FakeAnim[] = [];
    const animate = vi.fn(() => {
      const a: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
      anims.push(a);
      return a;
    });
    Element.prototype.animate = animate as never;
    deferPost();
    open();
    type("Ship Pro");
    send();
    const isFly = (i: number) =>
      (animate.mock.contexts[i] as Element).getAttribute("data-testid") === "send-fly-clone" &&
      (animate.mock.calls[i] as unknown as [Keyframe[]])[0][0].transform != null;
    const flies = animate.mock.calls.filter((_, i) => isFly(i));
    expect(flies).toHaveLength(1);
    const [frames] = flies[0] as unknown as [Keyframe[]];
    // Bubble text origin (200+12, 500+8) onto the composer's TEXT origin:
    // inside the field's padding (20+8, 700+4), where the letters were.
    expect(frames[0].transform).toBe("translate3d(-184px, 196px, 0px) scale(1)");
    expect(frames[frames.length - 1].transform).toBe("translate3d(0px, 0px, 0px) scale(1)");
    const bubble = bubbleOf(last());
    expect(bubble.style.visibility).toBe("hidden");
    expect(screen.getAllByTestId("send-fly-clone")).toHaveLength(1);
    const cloneAnim = anims[animate.mock.calls.findIndex((_, i) => isFly(i))];
    act(() => cloneAnim.onfinish?.());
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
    expect(bubbleOf(last()).style.visibility).toBe("");
  });

  it("reduced motion: no fly and no glide, the bubble just fades in", () => {
    stubGeometry();
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    reducedMotion();
    deferPost();
    open();
    type("Ship Pro");
    send();
    expect(animate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
    const bubble = bubbleOf(last());
    expect(bubble.style.visibility).toBe("");
    expect(bubble.className).toContain("zen-bubble-fade");
  });
});

describe("New comment ↓", () => {
  let height = 2000;
  beforeEach(() => {
    height = 2000;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "ticket-scroller" ? height : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "ticket-scroller" ? 500 : 0;
      },
    });
  });
  afterEach(() => {
    // @ts-expect-error restore jsdom's
    delete HTMLElement.prototype.scrollHeight;
    // @ts-expect-error restore jsdom's
    delete HTMLElement.prototype.clientHeight;
  });

  const scroller = () => screen.getByTestId("ticket-scroller");
  function scrollTo(top: number) {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  }

  it("reading up the ticket, someone else's comment offers the pill; the pill keeps the keyboard and glides down", () => {
    open();
    scrollTo(1500);
    scrollTo(200);
    height = 2100;
    act(() => {
      useFeedbackStore.setState({ openItem: withComments({ author: "sales", body: "Any update?", at: NOW }) });
    });
    expect(scroller().scrollTop).toBe(200);
    const pill = screen.getByTestId("ticket-new-comment");
    expect(pill.textContent).toBe("New comment ↓");
    for (const kind of ["pointerDown", "mouseDown"] as const) {
      const ev = createEvent[kind](pill);
      fireEvent(pill, ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    const glide = vi.fn();
    scroller().scrollTo = glide as never;
    fireEvent.click(pill);
    expect(glide).toHaveBeenCalledWith({ top: 2100, behavior: "smooth" });
    expect(screen.queryByTestId("ticket-new-comment")).toBeNull();
  });

  it("at the newest, a new comment is followed instead (no pill)", () => {
    open();
    scrollTo(1500);
    height = 2100;
    act(() => {
      useFeedbackStore.setState({ openItem: withComments({ author: "sales", body: "Any update?", at: NOW }) });
    });
    expect(scroller().scrollTop).toBe(2100);
    expect(screen.queryByTestId("ticket-new-comment")).toBeNull();
  });
});

describe("Comment draft per ticket", () => {
  it("keys drafts per server and ticket, apart from the Thread rooms", () => {
    expect(ticketDraftKey("s1", "t-wait")).toBe("s1|ticket:t-wait");
    expect(ticketDraftKey("s1", "t-wait")).not.toBe(composerDraftKey("s1", null, "t-wait"));
    expect(ticketDraftKey(null, "t-wait")).toBeNull();
    expect(ticketDraftKey("s1", " ")).toBeNull();
  });

  it("keeps unsent text per ticket across leaving and coming back; Send clears it", () => {
    vi.mocked(commentFeedback).mockReturnValue(new Promise(() => {}));
    const first = open();
    type("half a thought");
    expect(useComposerDrafts.getState().drafts["s1|ticket:t-wait"]?.text).toBe("half a thought");
    first.unmount();

    const other = open("t-other");
    expect(input().value).toBe("");
    other.unmount();

    open();
    expect(input().value).toBe("half a thought");
    send();
    expect(input().value).toBe("");
    expect(useComposerDrafts.getState().drafts["s1|ticket:t-wait"]).toBeUndefined();
  });
});
