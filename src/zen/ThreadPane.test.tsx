// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    uploadFsBinary: vi.fn(),
    createFsFolder: vi.fn(),
    answerThread: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});

vi.mock("../api/projectGroups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/projectGroups")>();
  return { ...actual, fetchProjectGroupShow: vi.fn(async () => ({ ok: false, error: "nope" })) };
});

vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));

import { act } from "@testing-library/react";
import { answerThread, createFsFolder, getThreadActivity, uploadFsBinary } from "../api/client";
import { fetchProjectGroupShow } from "../api/projectGroups";
import { connectOverlayEvents } from "./overlayEvents";
import { COMPOSER_MAX_PX, ThreadPane, composerHeight, threadTopPadding } from "./ThreadPane";
import { composerPlaceholder } from "./GlassComposer";
import { normaliseThreadItem } from "./threadModel";
import { useZenStore } from "./zenStore";

afterEach(() => {
  cleanup();
  vi.mocked(uploadFsBinary).mockReset();
  vi.mocked(answerThread).mockReset();
  vi.mocked(connectOverlayEvents).mockClear();
  useZenStore.setState({
    threadConversationId: null,
    threadGroupId: null,
    threadAddr: null,
    agentId: "",
    agents: [],
    answeringId: null,
    answerError: null,
    answerErrorId: null,
    outbox: [],
  });
});

describe("composerPlaceholder", () => {
  it("main chat: Message <Agent>", () => {
    expect(composerPlaceholder({ name: "K2 Companion", addr: "k2c" })).toBe(
      "Message K2 Companion"
    );
  });
  it("sidecar: Message <Agent>/<suffix>, not the renamed title", () => {
    expect(composerPlaceholder({ name: "K2", addr: "k2/reviewer", sidecar: "Renamed" })).toBe(
      "Message K2/reviewer"
    );
  });
  it("main addr with a sidecar title uses the title", () => {
    expect(composerPlaceholder({ name: "K2", addr: "k2", sidecar: "codex" })).toBe(
      "Message K2/codex"
    );
  });
  it("project group: Message <group>", () => {
    expect(composerPlaceholder({ name: "Launch", kind: "group" })).toBe("Message Launch");
  });
  it("falls back to Message", () => {
    expect(composerPlaceholder(null)).toBe("Message");
    expect(composerPlaceholder({ name: "  " })).toBe("Message");
    expect(composerPlaceholder({ name: "—", addr: "k2/1" })).toBe("Message");
  });
});

describe("ThreadPane", () => {
  const live = {
    threadSource: "live" as const,
    threadError: null,
    sendError: null,
    sending: false,
    thread: [],
  };

  it("main chat placeholder: Message <Agent>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: "k2",
      agentId: "a1",
      agents: [{ id: "a1", name: "K2", initial: "K", addr: "k2" }],
    });
    render(<ThreadPane />);
    const input = screen.getByTestId("composer-input");
    expect(input.getAttribute("placeholder")).toBe("Message K2");
    expect(input.getAttribute("aria-label")).toBe("Message K2");
    expect(input.className).toMatch(/placeholder:text-ellipsis/);
  });

  it("sidecar placeholder: Message <Agent>/<sidecar>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: "k2/reviewer",
      agentId: "s1",
      agents: [
        { id: "s1", name: "K2", initial: "K", addr: "k2/reviewer", chatTitle: "Code review" },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe(
      "Message K2/reviewer"
    );
  });

  it("project chat placeholder: Message <group>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: null,
      threadGroupId: "g1",
      agentId: "grp",
      agents: [{ id: "grp", name: "Launch", initial: "L", kind: "group", groupId: "g1" }],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe(
      "Message Launch"
    );
  });

  it("placeholder falls back to Message with no agent", () => {
    useZenStore.setState({ ...live, threadAddr: "k2", agentId: "", agents: [] });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe("Message");
  });

  it("renders a structured daemon error as text, not a throw", () => {
    useZenStore.setState({
      threadSource: "error",
      threadError: { code: "not_found", hint: "unknown overlay addr 'k2so-Skin-Test-A'" } as unknown as string,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByText(/unknown overlay addr/)).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByPlaceholderText("Message")).not.toBeNull();
  });

  it("labels the composer on stub — POST is not proven", () => {
    useZenStore.setState({
      threadSource: "stub",
      threadError: null,
      thread: [
        {
          id: "s1",
          seq: 0,
          text: "STUB thread",
          from: "[STUB] not-a-real-agent-1",
          at: null,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-label").textContent).toMatch(
      /STUB — Cannot send — POST \/cli\/thread\/post not proven/
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("live empty thread is labelled No messages yet, not a blank pane", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-empty").textContent).toBe("No messages yet");
    expect(screen.queryByText(/unknown overlay addr/)).toBeNull();
  });

  it("error pane does not also say No messages", () => {
    useZenStore.setState({
      threadSource: "error",
      threadError: "Not chattable",
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByText("Not chattable")).not.toBeNull();
    expect(screen.queryByTestId("thread-empty")).toBeNull();
  });

  it("composer row is min-w-0 so the pill cannot span the files column", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    const label = screen.getByTestId("composer-label");
    expect(label.className).toMatch(/break-words/);
    const input = screen.getByPlaceholderText("Message");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.className).toMatch(/min-w-0/);
    expect(input.className).toMatch(/resize-none/);
    expect(input.className).toMatch(/overflow-x-hidden/);
    expect(input.className).toMatch(/whitespace-pre-wrap/);
    const pill = input.parentElement;
    expect(pill?.className).toMatch(/min-w-0/);
    expect(pill?.className).toMatch(/items-end/);
  });

  it("composer height grows then caps", () => {
    expect(composerHeight(22)).toBe(24);
    expect(composerHeight(88)).toBe(88);
    expect(composerHeight(400)).toBe(COMPOSER_MAX_PX);
  });

  it("a sidecar with a thread GET error can still send", () => {
    useZenStore.setState({
      threadSource: "error",
      threadAddr: "appa/1",
      threadError: "unknown overlay addr 'appa/1'",
      sendError: null,
      sending: false,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Not chattable/);
  });

  it("live thread that is not a test room can send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "hello from the agent",
          from: "appa",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("hello from the agent")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Cannot send/);
  });

  it("live test-room thread shows Send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "skin-test-a",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "hello from the agent",
          from: "skin-test-a",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Cannot send/);
  });

  it("renders markdown and choice options, not raw asterisks or a blank card", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "md",
          seq: 1,
          text: "**bold one**",
          from: "k2so-companion-qa",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "k2",
          at: 1759198521,
          mine: false,
          kind: "choice",
          choice: { prompt: "Pick one", options: ["left", "right"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("bold one")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/\*\*bold one\*\*/);
    expect(screen.getByText("Pick one")).not.toBeNull();
    expect(screen.getByRole("button", { name: "left" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "right" })).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Reply is not wired/);
  });

  it("bubbles and the composer follow Settings → Text Size (--zen-text-scale)", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "t1",
          seq: 1,
          text: "hello",
          from: "k2",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    const bubble = screen.getByTestId("thread-bubble");
    expect(bubble.getAttribute("style")).toContain("var(--zen-text-scale");
    expect(bubble.querySelector(".chat-markdown")?.getAttribute("style")).toContain(
      "var(--zen-text-scale"
    );
    expect(screen.getByTestId("composer-input").getAttribute("style")).toContain(
      "var(--zen-text-scale"
    );
  });

  it("tapping a choice POSTs /cli/thread/answer with the option text", async () => {
    vi.mocked(answerThread).mockResolvedValue({ ok: true, data: {} });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: "appa",
      threadGroupId: null,
      thread: [
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "appa",
          at: 1759198521,
          mine: false,
          kind: "choice",
          choice: { prompt: "Approve this?", options: ["Yes", "No"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => {
      expect(answerThread).toHaveBeenCalledWith(expect.anything(), "appa", "ch", "Yes");
    });
    await waitFor(() => {
      expect(screen.getByText("Answered.")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Yes" })).toHaveProperty("disabled", true);
  });

  it("does not POST a choice on a project chat", () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: null,
      threadGroupId: "g1",
      thread: [
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "appa",
          at: 1,
          mine: false,
          kind: "choice",
          choice: { prompt: "Pick", options: ["A"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(answerThread).not.toHaveBeenCalled();
  });

  it("secret cards have no answer buttons", () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: "appa",
      thread: [
        {
          id: "sec",
          seq: 3,
          text: "Need a secret",
          from: "appa",
          at: 1,
          mine: false,
          kind: "secret",
          choice: { prompt: "Need a secret", options: ["ok"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.queryByRole("button", { name: "ok" })).toBeNull();
    expect(answerThread).not.toHaveBeenCalled();
  });

  it("renders choice option labels from wire objects, not [object Object]", () => {
    const m = normaliseThreadItem(
      {
        id: "c18",
        seq: 18,
        doc: {
          kind: "choice",
          from: "k2so-companion-qa",
          choice: {
            prompt: "How do you want to sign in?",
            options: [{ label: "Secret" }, { label: "Phone" }, { label: "Hold" }],
          },
        },
      },
      "baden"
    );
    expect(m).not.toBeNull();
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [m!],
    });
    render(<ThreadPane />);
    expect(screen.getByText(/Secret/)).not.toBeNull();
    expect(screen.getByText(/Phone/)).not.toBeNull();
    expect(screen.getByText(/Hold/)).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
  });

  it("lands the scroller on the newest message on first layout", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? 1800 : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        {
          id: "old",
          seq: 1,
          text: "oldest",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
        {
          id: "new",
          seq: 19,
          text: "newest",
          from: "appa",
          at: 2,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-scroller").scrollTop).toBe(1800);
    expect(screen.getByText("newest")).not.toBeNull();
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  it("keyboard resize re-sticks to the newest only when the reader was there", () => {
    let height = 1800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
        { id: "b", seq: 2, text: "two", from: "appa", at: 2, mine: false, kind: "text", choice: null },
      ],
    });
    const { rerender } = render(<ThreadPane viewportHeight={800} />);
    const el = screen.getByTestId("thread-scroller");
    expect(el.scrollTop).toBe(1800);

    // Keyboard opens: the column shrinks, the reader was at the newest.
    height = 2100;
    rerender(<ThreadPane viewportHeight={464} />);
    expect(el.scrollTop).toBe(2100);

    // Reader scrolls up to history: a resize must not yank them down.
    el.scrollTop = 200;
    fireEvent.scroll(el);
    height = 2400;
    rerender(<ThreadPane viewportHeight={800} />);
    expect(el.scrollTop).toBe(200);

    expect(screen.getByTestId("composer-bar").className).toMatch(/zen-composer-bar/);
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  /** A scroller that clamps like a browser: scrollHeight `sh`, a
   *  clientHeight that follows `client()`. */
  function clampingScroller(el: HTMLElement, sh: () => number, client: () => number) {
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: sh });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: client });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => Math.max(0, Math.min(top, sh() - client())),
      set: (v: number) => {
        top = Math.max(0, Math.min(v, sh() - client()));
      },
    });
  }
  const EASE = "cubic-bezier(0.38, 0.7, 0.125, 1)";
  const motion = (from: number, to: number, ms = 250, elapsed = 0) => ({
    ms,
    easing: EASE,
    elapsed,
    from,
    to,
  });
  function seedThread() {
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
      ],
    });
  }

  it("keyboard hide (FLIP): final layout at once; composer and list start where they were drawn and play to 0 on the keyboard's timing", () => {
    seedThread();
    let client = 400;
    const { rerender } = render(<ThreadPane viewportHeight={464} />);
    const el = screen.getByTestId("thread-scroller");
    clampingScroller(el, () => 2400, () => client);
    el.scrollTop = 99999;
    fireEvent.scroll(el); // at the newest: following
    expect(el.scrollTop).toBe(2000);
    const dock = screen.getByTestId("thread-composer-dock");
    const content = screen.getByTestId("thread-content");
    let inverted: string[] = [];
    dock.getBoundingClientRect = () => {
      inverted = [dock.style.transform, dock.style.transition, content.style.transform];
      return new DOMRect();
    };
    // The keyboard hides: the column is already full height (Zen).
    client = 736;
    rerender(<ThreadPane viewportHeight={800} viewportMotion={motion(464, 800, 250, 12)} />);
    // Re-stuck at once (the list moved down 336 at the commit)…
    expect(el.scrollTop).toBe(1664);
    // …and, at the flush, both drawn back where they were:
    expect(inverted).toEqual(["translate3d(0, -336px, 0)", "none", "translate3d(0, -336px, 0)"]);
    // then played to 0 on the keyboard's duration + curve (mid-curve by
    // the bridge hop).
    expect(dock.style.transform).toBe("");
    expect(dock.style.transition).toBe(`transform 250ms ${EASE} -12ms`);
    expect(content.style.transform).toBe("");
    expect(content.style.transition).toBe(`transform 250ms ${EASE} -12ms`);
    // Motion over: transforms cleared, no transition left.
    rerender(<ThreadPane viewportHeight={800} viewportMotion={null} />);
    expect(dock.style.transition).toBe("none");
    expect(content.style.transition).toBe("none");
    expect(el.scrollTop).toBe(1664);
  });

  it("keyboard hide while reading history: only the composer plays; the list stays put", () => {
    seedThread();
    let client = 400;
    const { rerender } = render(<ThreadPane viewportHeight={464} />);
    const el = screen.getByTestId("thread-scroller");
    clampingScroller(el, () => 2400, () => client);
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    el.scrollTop = 500;
    fireEvent.scroll(el); // scrolled up: not following
    const content = screen.getByTestId("thread-content");
    client = 736;
    rerender(<ThreadPane viewportHeight={800} viewportMotion={motion(464, 800)} />);
    expect(el.scrollTop).toBe(500);
    expect(content.style.transform).toBe("");
    expect(content.style.transition).toBe("");
    expect(screen.getByTestId("thread-composer-dock").style.transition).toBe(`transform 250ms ${EASE}`);
  });

  it("keyboard show: the column is held; composer and list play up to the new layout, which commits as the motion clears", () => {
    seedThread();
    let client = 736;
    const { rerender } = render(<ThreadPane viewportHeight={800} />);
    const el = screen.getByTestId("thread-scroller");
    clampingScroller(el, () => 2400, () => client);
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(1664);
    const dock = screen.getByTestId("thread-composer-dock");
    const content = screen.getByTestId("thread-content");
    rerender(<ThreadPane viewportHeight={464} viewportMotion={motion(800, 464)} />);
    // Nothing re-laid out yet (Zen holds the column at 800).
    expect(el.scrollTop).toBe(1664);
    expect(dock.style.transform).toBe("translate3d(0, -336px, 0)");
    expect(dock.style.transition).toBe(`transform 250ms ${EASE}`);
    expect(content.style.transform).toBe("translate3d(0, -336px, 0)");
    // The motion clears: the column takes 464, transforms go, re-stuck —
    // same picture.
    client = 400;
    rerender(<ThreadPane viewportHeight={464} viewportMotion={null} />);
    expect(dock.style.transform).toBe("");
    expect(content.style.transform).toBe("");
    expect(el.scrollTop).toBe(2000);
  });

  it("reduced motion (no motion object): final layout, no transforms", () => {
    seedThread();
    let client = 400;
    const { rerender } = render(<ThreadPane viewportHeight={464} />);
    const el = screen.getByTestId("thread-scroller");
    clampingScroller(el, () => 2400, () => client);
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    client = 736;
    rerender(<ThreadPane viewportHeight={800} />);
    expect(screen.getByTestId("thread-composer-dock").style.transform).toBe("");
    expect(screen.getByTestId("thread-content").style.transform).toBe("");
    expect(el.scrollTop).toBe(1664);
  });

  it("interactive keyboard dismiss: no re-pin under the finger nor over the release; pinning resumes after", () => {
    let height = 1800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    try {
      useZenStore.setState({
        agentId: "appa",
        threadSource: "live",
        threadError: null,
        threadHasMore: false,
        thread: [
          { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
        ],
      });
      const { rerender } = render(<ThreadPane viewportHeight={464} />);
      const el = screen.getByTestId("thread-scroller");
      expect(el.scrollTop).toBe(1800);
      // The finger drags the list (and the keyboard) down: the reader
      // owns the scroll; layout changes must not stick it back.
      rerender(<ThreadPane viewportHeight={464} viewportInteractive />);
      el.scrollTop = 1750;
      height = 1900;
      rerender(<ThreadPane viewportHeight={500} viewportInteractive />);
      expect(el.scrollTop).toBe(1750);
      // Released (WillHide): the finger's scroll (and its momentum)
      // stands; only the composer plays.
      const motion = (from: number, to: number) => ({
        ms: 200,
        easing: "ease-out",
        elapsed: 0,
        from,
        to,
      });
      const content = screen.getByTestId("thread-content");
      rerender(<ThreadPane viewportHeight={800} viewportMotion={motion(560, 800)} />);
      expect(el.scrollTop).toBe(1750);
      expect(content.style.transform).toBe("");
      expect(screen.getByTestId("thread-composer-dock").style.transition).toBe("transform 200ms ease-out");
      // …nor when that motion ends.
      rerender(<ThreadPane viewportHeight={800} viewportMotion={null} />);
      expect(el.scrollTop).toBe(1750);
      // The next keyboard change pins again (following).
      rerender(<ThreadPane viewportHeight={464} viewportMotion={motion(800, 464)} />);
      rerender(<ThreadPane viewportHeight={464} viewportMotion={null} />);
      expect(el.scrollTop).toBe(1900);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
          return 0;
        },
      });
    }
  });

  it("keyboard up: real scroll range above (top room), compensated; dropped once idle after it closes", () => {
    let height = 400;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    const full = window.innerHeight;
    try {
      useZenStore.setState({
        agentId: "appa",
        threadSource: "live",
        threadError: null,
        threadHasMore: false,
        thread: [
          { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
        ],
      });
      (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup = true;
      // A short chat, keyboard closed: no room.
      const { rerender } = render(<ThreadPane viewportHeight={full} />);
      const el = screen.getByTestId("thread-scroller");
      const room = screen.getByTestId("thread-kb-top-room");
      const content = screen.getByTestId("thread-content");
      el.scrollTop = 0;
      fireEvent.scroll(el);
      // Reading at the top (not following): the room must not move the view.
      el.scrollTop = 0;
      const inset = 336;
      rerender(<ThreadPane viewportHeight={full - inset} />);
      expect(room.style.height).toBe(`${inset + 48}px`);
      expect(content.style.minHeight).toBe("100%");
      // jsdom does not clamp: the compensation is the whole room.
      expect(el.scrollTop).toBeGreaterThanOrEqual(inset + 48);
      // The drag layer sits in the scrolled content.
      expect(screen.getByTestId("thread-kb-drag-layer").parentElement).toBe(el);
      // Keyboard closes; the room stays while scrolling continues…
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      fireEvent.scroll(el);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const before = el.scrollTop;
      rerender(<ThreadPane viewportHeight={full} />);
      expect(room.style.height).toBe(`${inset + 48}px`);
      // …and goes once idle, scrollTop compensated.
      clock.mockImplementation(() => now + 1000);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      vi.useRealTimers();
      clock.mockRestore();
      expect(room.style.height).toBe("");
      expect(content.style.minHeight).toBe("");
      expect(el.scrollTop).toBe(Math.max(0, before - (inset + 48)));
      // Not the iOS shell (Android): no room at all.
      delete (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup;
      rerender(<ThreadPane viewportHeight={full - inset} />);
      expect(room.style.height).toBe("");
    } finally {
      delete (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup;
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
          return 0;
        },
      });
    }
  });

  it("composer focus flips the pane's gap attribute in the focus event, and the scroller ends in the gap spacer", () => {
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [],
    });
    render(<ThreadPane viewportHeight={800} />);
    const scroller = screen.getByTestId("thread-scroller");
    const root = scroller.parentElement as HTMLElement;
    expect(root.className).toMatch(/\bzen-thread-pane\b/);
    const gap = screen.getByTestId("thread-composer-gap");
    expect(gap.parentElement).toBe(scroller);
    expect(gap.className).toMatch(/\bzen-composer-gap\b/);
    // Interactive keyboard dismiss: the drag pad ends the scroller (empty
    // at rest); the dock carries no transform at rest.
    const pad = screen.getByTestId("thread-kb-drag-pad");
    expect(pad.parentElement).toBe(scroller);
    expect(pad.style.height).toBe("");
    expect(screen.getByTestId("thread-composer-dock").style.transform).toBe("");
    const ta = screen.getByTestId("composer-bar").querySelector("textarea")!;
    expect(root.hasAttribute("data-composer-focused")).toBe(false);
    fireEvent.focusIn(ta);
    expect(root.hasAttribute("data-composer-focused")).toBe(true);
    // Focus moving within the bar keeps it.
    const other = screen.getByTestId("composer-bar").querySelector("button");
    if (other) {
      fireEvent.focusOut(ta, { relatedTarget: other });
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
    }
    // Keyboard dismissed (focus leaves to nothing).
    fireEvent.focusOut(ta, { relatedTarget: null });
    expect(root.hasAttribute("data-composer-focused")).toBe(false);
    // The keyboard hiding on its own (a drag-dismiss) while the field is
    // still focused: blur it and take the resting gap.
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const will = (show: boolean) =>
      act(() => {
        window.dispatchEvent(
          new CustomEvent("k2-keyboard-will", { detail: { show, height: show ? 336 : 0, duration: 250 } })
        );
      });
    try {
      ta.focus();
      fireEvent.focusIn(ta);
      will(true);
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
      now += 2000;
      will(false);
      expect(root.hasAttribute("data-composer-focused")).toBe(false);

      // Then the reader taps the field again (TestFlight 1446): a stale
      // hide (the keyboard is not up yet) must not undo that tap…
      fireEvent.focusIn(ta);
      will(false);
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
      // …nor a hide right after the keyboard starts back up.
      will(true);
      now += 100;
      will(false);
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("pads the scroller under a floating header and keeps the newest in view when it grows", () => {
    expect(threadTopPadding(undefined)).toBeUndefined();
    expect(threadTopPadding(0)).toBeUndefined();
    expect(threadTopPadding(84)).toBe("calc(env(safe-area-inset-top) + 92px)");

    let height = 1800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
      ],
    });
    const { rerender } = render(<ThreadPane viewportHeight={800} topInset={84} />);
    const el = screen.getByTestId("thread-scroller");
    expect(el.style.paddingTop).toMatch(/env\(safe-area-inset-top\)/);
    expect(el.style.paddingTop).toMatch(/92px/);
    expect(el.scrollTop).toBe(1800);

    // Sidecar line appears: header grows, padding grows, tail stays stuck.
    height = 1820;
    rerender(<ThreadPane viewportHeight={800} topInset={104} />);
    expect(el.style.paddingTop).toMatch(/112px/);
    expect(el.scrollTop).toBe(1820);

    // Without a floating header the stock padding applies.
    rerender(<ThreadPane viewportHeight={800} />);
    expect(el.style.paddingTop).toBe("");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  it("outgoing bubbles shrink so a code block cannot clip the left edge", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      thread: [
        {
          id: "m1",
          seq: 0,
          text: "```\n" + "x".repeat(200) + "\n```",
          from: "baden",
          at: 10,
          mine: true,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    const row = document.querySelector("[data-thread-msg]");
    expect(row?.className).toMatch(/min-w-0/);
    expect(row?.className).toMatch(/max-w-\[78%\]/);
  });

  it("a live project chat shows Send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: null,
      threadGroupId: "pg1",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 0,
          text: "hello project",
          from: "owner",
          at: 10,
          mine: true,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Not chattable/);
    expect(screen.getByTestId("composer-attach")).toHaveProperty("disabled", true);
  });

  it("loading hides leftover bubbles", () => {
    useZenStore.setState({
      threadSource: "loading",
      threadError: null,
      thread: [
        {
          id: "stale",
          seq: 1,
          text: "STALE BUBBLE",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-loading").textContent).toMatch(/LOADING thread/);
    expect(screen.queryByText("STALE BUBBLE")).toBeNull();
  });

  it("live workspace thread has an Add file control and paste lands a chip", () => {
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Add file" })).not.toBeNull();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: {
        files: [file],
        items: [],
      },
    });
    expect(screen.getByTestId("attach-chip").textContent).toMatch(/shot.png/);
  });

  function openAppa(sendThread: () => Promise<boolean>) {
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
      sendThread,
    });
  }

  function pasteAndSend(file: File, caption = "") {
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: { files: [file], items: [] },
    });
    if (caption) {
      fireEvent.change(screen.getByPlaceholderText(/Message/), { target: { value: caption } });
    }
    fireEvent.submit(screen.getByTestId("composer-form"));
  }

  it("uploads into <workspace>/.k2/downloads and sends that path", async () => {
    vi.mocked(uploadFsBinary).mockResolvedValue({
      ok: true,
      data: { path: "/Users/Baden/Appa/.k2/downloads/shot.png" },
    });
    const sendThread = vi.fn(async () => true);
    openAppa(sendThread);
    render(<ThreadPane />);
    pasteAndSend(new File(["x"], "shot.png", { type: "image/png" }), "see this");
    await waitFor(() => expect(uploadFsBinary).toHaveBeenCalled());
    expect(vi.mocked(uploadFsBinary).mock.calls[0][1]).toBe("appa");
    expect(vi.mocked(uploadFsBinary).mock.calls[0][2]).toBe("/Users/Baden/Appa/.k2/downloads");
    expect(vi.mocked(uploadFsBinary).mock.calls[0][3]).toBe("shot.png");
    await waitFor(() =>
      expect(sendThread).toHaveBeenCalledWith(
        "see this /Users/Baden/Appa/.k2/downloads/shot.png",
        { localId: expect.any(String) }
      )
    );
  });

  it("a missing .k2/downloads is created by the upload itself (no separate mkdir)", async () => {
    // Daemon `write_upload` runs `create_dir_all(dir)` before writing, so
    // the first upload into a fresh workspace needs no fs/create (desktop
    // relies on the same).
    vi.mocked(uploadFsBinary).mockResolvedValue({
      ok: true,
      data: { path: "/Users/Baden/Appa/.k2/downloads/shot.png" },
    });
    const sendThread = vi.fn(async () => true);
    openAppa(sendThread);
    render(<ThreadPane />);
    pasteAndSend(new File(["x"], "shot.png", { type: "image/png" }));
    await waitFor(() => expect(sendThread).toHaveBeenCalled());
    expect(uploadFsBinary).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadFsBinary).mock.calls[0][2]).toBe("/Users/Baden/Appa/.k2/downloads");
    expect(createFsFolder).not.toHaveBeenCalled();
  });

  it("a name clash sends the daemon's `name (1).ext` path, quoted like desktop", async () => {
    vi.mocked(uploadFsBinary).mockResolvedValue({
      ok: true,
      data: { path: "/Users/Baden/Appa/.k2/downloads/shot (1).png" },
    });
    const sendThread = vi.fn(async () => true);
    openAppa(sendThread);
    render(<ThreadPane />);
    pasteAndSend(new File(["x"], "shot.png", { type: "image/png" }));
    await waitFor(() =>
      expect(sendThread).toHaveBeenCalledWith(
        "'/Users/Baden/Appa/.k2/downloads/shot (1).png'",
        { localId: expect.any(String) }
      )
    );
    // The phone sends the picked name; the daemon picks ` (1)`.
    expect(vi.mocked(uploadFsBinary).mock.calls[0][3]).toBe("shot.png");
  });

  it("a project chat uploads into its PoC member's .k2/downloads", async () => {
    vi.mocked(fetchProjectGroupShow).mockResolvedValueOnce({
      ok: true,
      data: {
        id: "pg1",
        name: "K2",
        pocWorkspaceId: "w2",
        members: [
          { workspaceId: "w1", name: "other", path: "/Users/Baden/Other", agentName: null, createdAt: 0 },
          { workspaceId: "w2", name: "appa", path: "/Users/Baden/Appa", agentName: "Appa", createdAt: 0 },
        ],
      } as never,
    });
    vi.mocked(uploadFsBinary).mockResolvedValue({
      ok: true,
      data: { path: "/Users/Baden/Appa/.k2/downloads/shot.png" },
    });
    const sendThread = vi.fn(async () => true);
    useZenStore.setState({
      agentId: "group:pg1",
      agents: [
        { id: "group:pg1", name: "K2", initial: "K", kind: "group", groupId: "pg1", memberCount: 2, addr: null, joinMiss: null },
      ] as never,
      threadSource: "live",
      threadAddr: null,
      threadGroupId: "pg1",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
      sendThread,
    });
    render(<ThreadPane />);
    await waitFor(() =>
      expect(screen.getByTestId("composer-attach")).toHaveProperty("disabled", false)
    );
    expect(useZenStore.getState().groupRoot).toBe("/Users/Baden/Appa");
    pasteAndSend(new File(["x"], "shot.png", { type: "image/png" }));
    await waitFor(() => expect(uploadFsBinary).toHaveBeenCalled());
    expect(vi.mocked(uploadFsBinary).mock.calls[0].slice(1, 4)).toEqual([
      "appa",
      "/Users/Baden/Appa/.k2/downloads",
      "shot.png",
    ]);
    await waitFor(() =>
      expect(sendThread).toHaveBeenCalledWith("/Users/Baden/Appa/.k2/downloads/shot.png", {
        localId: expect.any(String),
      })
    );
  });

  it("does not upload when the agent path is the daemon cwd", async () => {
    const sendThread = vi.fn(async () => true);
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: ".",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
      sendThread,
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-attach")).toHaveProperty("disabled", true);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: {
        files: [file],
        items: [],
      },
    });
    expect(screen.queryByTestId("attach-chip")).toBeNull();
    expect(uploadFsBinary).not.toHaveBeenCalled();
  });

  it("tapping an @file mention opens that file in the stage", () => {
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      fileSource: "live",
      files: [
        { id: "/Users/Baden/Appa/AGENTS.md", name: "AGENTS.md", body: "hi" },
      ],
      openFileIds: [],
      focusId: null,
      filesOpen: false,
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "see @AGENTS.md",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("chat-file-link"));
    expect(useZenStore.getState().openFileIds).toEqual([
      "/Users/Baden/Appa/AGENTS.md",
    ]);
    expect(useZenStore.getState().filesOpen).toBe(true);
  });

  it("opens the overlay events socket for a live conversation", () => {
    const stop = vi.fn();
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop, setViewing: vi.fn() });
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "k2so-companion",
      threadGroupId: null,
      threadConversationId: "conv-live",
      threadError: null,
      thread: [],
    });
    const { unmount } = render(<ThreadPane />);
    expect(connectOverlayEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectOverlayEvents).mock.calls[0][0].conversationId).toBe(
      "conv-live"
    );
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shows the working strip from an activity frame, never as a message", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "k2so-companion",
      threadGroupId: null,
      threadConversationId: "conv-live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    const now = Date.now();
    act(() => {
      opts.onItem({
        collection: "activity",
        seq: 0,
        id: "t-1",
        activity: {
          turnId: "t-1",
          state: "working",
          phase: "tool",
          phaseSince: now - 3_000,
          line: "Running `npm test`",
          startedAt: now - 12_000,
          subagents: 1,
          subagentsDone: 0,
          background: 0,
          tally: { read: 2, search: 0, cmd: 1, edit: 0 },
          waitingOn: null,
          end: null,
          serverNow: now,
          rev: 3,
        },
      } as never);
    });
    const strip = screen.getByTestId("thread-working-strip");
    expect(strip.getAttribute("data-tone")).toBe("working");
    // Docked above the composer, not a row in the message list.
    expect(screen.getByTestId("thread-scroller").contains(strip)).toBe(false);
    // Passed through the composer's drawer slot: inside the composer's
    // wrapper, directly before the field.
    const slot = screen.getByTestId("composer-drawer");
    const field = screen.getByTestId("composer-field");
    expect(slot.contains(strip)).toBe(true);
    expect(slot.nextElementSibling).toBe(field);
    expect(slot.parentElement).toBe(screen.getByTestId("composer-dock"));
    expect(screen.getByTestId("composer-bar").contains(strip)).toBe(true);
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Running npm test");
    const icon = (key: string) =>
      screen.getByTestId(`thread-strip-count-${key}`).querySelector("svg")?.getAttribute("data-k2-icon");
    expect(icon("subagents")).toBe("agent");
    expect(screen.getByTestId("thread-strip-running").textContent).toMatch(/1$/);
    expect(icon("read")).toBe("file");
    expect(screen.getByTestId("thread-strip-count-read").textContent).toContain("2");
    expect(icon("cmd")).toBe("terminal");
    expect(screen.getByTestId("thread-strip-count-cmd").textContent).toContain("1");
    expect(useZenStore.getState().thread).toEqual([]);
    act(() => {
      opts.onItem({
        collection: "activity",
        seq: 0,
        id: "t-1",
        activity: {
          turnId: "t-1",
          state: "idle",
          phase: "working",
          phaseSince: now,
          startedAt: now - 12_000,
          tally: {},
          end: { reason: "reply", detail: null, at: now },
          serverNow: now,
          rev: 4,
        },
      } as never);
    });
    // Slides down behind the composer, then is gone.
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-leaving")).toBe("true");
    await waitFor(() => expect(screen.queryByTestId("thread-working-strip")).toBeNull());
  });

  it("re-reads the live turn on every socket open", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    vi.mocked(getThreadActivity).mockClear();
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-2",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    // No catch-up before the socket: onOpen fires on the first open too.
    expect(getThreadActivity).not.toHaveBeenCalled();
    const now = Date.now();
    vi.mocked(getThreadActivity).mockResolvedValueOnce({
      ok: true,
      data: {
        turn: {
          turnId: "t-9",
          state: "needs-you",
          phase: "waiting",
          phaseSince: now - 5_000,
          startedAt: now - 60_000,
          waitingOn: "permission",
          end: null,
          serverNow: now,
          rev: 2,
        },
      },
    } as never);
    act(() => vi.mocked(connectOverlayEvents).mock.calls[0][0].onOpen?.());
    await waitFor(() => expect(screen.getByTestId("thread-working-strip")).not.toBeNull());
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-tone")).toBe("needs-you");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe(
      "Stuck on a permission prompt"
    );
  });

  it("keeps a late {turn:null} catch-up from clearing a newer live turn", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    vi.mocked(getThreadActivity).mockClear();
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-3",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const now = Date.now();
    let resolveOld: (v: unknown) => void = () => {};
    vi.mocked(getThreadActivity)
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)) as never)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          turn: {
            turnId: "t-5",
            state: "working",
            phase: "working",
            phaseSince: now - 1_000,
            startedAt: now - 9_000,
            end: null,
            serverNow: now,
            rev: 1,
          },
        },
      } as never);
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    act(() => opts.onOpen?.());
    act(() => opts.onNeedCatchUp());
    await waitFor(() => expect(screen.getByTestId("thread-working-strip")).not.toBeNull());
    await act(async () => resolveOld({ ok: true, data: { turn: null } }));
    expect(screen.getByTestId("thread-working-strip")).not.toBeNull();
  });

  it("keeps chatter and other non-thread frames out of the message list", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-4",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    const doc = (id: string, body: string) => ({
      id,
      kind: "text",
      from: "appa",
      to: "owner",
      created_at: 1_760_190_000,
      body,
      via: "thread",
    });
    act(() => {
      opts.onItem({ collection: "chatter", seq: 7, id: "c-1", doc: doc("c-1", "chatter") } as never);
      opts.onItem({ collection: "chatterlog", seq: 8, id: "c-2", doc: doc("c-2", "log") } as never);
    });
    expect(useZenStore.getState().thread).toEqual([]);
    act(() => {
      opts.onItem({ collection: "thread", seq: 9, id: "m-1", doc: doc("m-1", "hello") } as never);
    });
    expect(useZenStore.getState().thread.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("does not open the overlay events socket without a conversation id", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: null,
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    expect(connectOverlayEvents).not.toHaveBeenCalled();
  });

  describe("composer field (iMessage layout)", () => {
    const liveState = () =>
      useZenStore.setState({
        threadSource: "live",
        threadAddr: "skin-test-a",
        threadGroupId: null,
        threadError: null,
        sendError: null,
        sending: false,
        thread: [],
      });

    it("send is disabled with an empty draft and enabled after typing", () => {
      liveState();
      render(<ThreadPane />);
      const send = screen.getByRole("button", { name: "Send" });
      expect(send).toHaveProperty("disabled", true);
      expect(send.getAttribute("type")).toBe("submit");
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "   " } });
      expect(send).toHaveProperty("disabled", true);
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hi" } });
      expect(screen.getByTestId("composer-send")).toHaveProperty("disabled", false);
      expect(screen.getByTestId("composer-send").querySelector("svg")).not.toBeNull();
    });

    it("renders attach, input and send inside the one field", () => {
      liveState();
      render(<ThreadPane />);
      const field = screen.getByTestId("composer-field");
      expect(field.contains(screen.getByTestId("composer-attach"))).toBe(true);
      expect(field.contains(screen.getByTestId("composer-input"))).toBe(true);
      expect(field.contains(screen.getByTestId("composer-send"))).toBe(true);
      expect(screen.getByRole("button", { name: "Add file" })).not.toBeNull();
    });
  });
});
describe("ThreadPane tap-to-dismiss (mobile chat kit)", () => {
  it("a tap on the conversation blurs the composer", () => {
    useZenStore.setState({ agentId: "appa", threadSource: "live", threadError: null, thread: [] });
    render(<ThreadPane viewportHeight={464} />);
    const field = screen.getByTestId("composer-bar").querySelector("textarea")!;
    act(() => field.focus());
    const ev = (el: Element, type: string, t: number) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, "pointerId", { value: 1 });
      Object.defineProperty(e, "clientX", { value: 5 });
      Object.defineProperty(e, "clientY", { value: 5 });
      Object.defineProperty(e, "timeStamp", { value: t });
      act(() => {
        el.dispatchEvent(e);
      });
    };
    const scroller = screen.getByTestId("thread-scroller");
    ev(scroller, "pointerdown", 100);
    ev(scroller, "pointermove", 140);
    ev(scroller, "pointerup", 150);
    expect(document.activeElement).not.toBe(field);
  });
});

describe("ThreadPane: close the keyboard, then tap the field (TestFlight 1446)", () => {
  it("the field takes focus and keeps it; the gap attribute only while focused; no blur loop", () => {
    useZenStore.setState({
      agentId: "appa",
      threadAddr: "appa",
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane viewportHeight={464} />);
    const root = screen.getByTestId("thread-scroller").parentElement as HTMLElement;
    const ta = screen.getByTestId("composer-bar").querySelector("textarea")!;
    expect(ta.disabled).toBe(false);
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const will = (show: boolean) =>
      act(() => {
        window.dispatchEvent(
          new CustomEvent("k2-keyboard-will", { detail: { show, height: show ? 336 : 0, duration: 250 } })
        );
      });
    const tap = (el: Element) => {
      const ev = (type: string, t: number) => {
        const e = new Event(type, { bubbles: true });
        Object.defineProperty(e, "pointerId", { value: 1 });
        Object.defineProperty(e, "clientX", { value: 5 });
        Object.defineProperty(e, "clientY", { value: 5 });
        Object.defineProperty(e, "timeStamp", { value: t });
        act(() => {
          el.dispatchEvent(e);
        });
      };
      ev("pointerdown", 100);
      ev("pointerup", 160);
    };
    try {
      act(() => ta.focus());
      will(true);
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
      now += 2000;
      // Dismiss by a tap on the conversation; the keyboard hides.
      tap(screen.getByTestId("thread-scroller"));
      will(false);
      expect(document.activeElement).not.toBe(ta);
      expect(root.hasAttribute("data-composer-focused")).toBe(false);
      // Tap the field again; late hide notifications must not undo it.
      now += 2000;
      act(() => ta.focus());
      will(false);
      will(true);
      now += 50;
      will(false);
      expect(document.activeElement).toBe(ta);
      expect(root.hasAttribute("data-composer-focused")).toBe(true);
      // A real hide later (the keyboard was up, the focus is not fresh).
      now += 2000;
      will(false);
      expect(document.activeElement).not.toBe(ta);
      expect(root.hasAttribute("data-composer-focused")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});
