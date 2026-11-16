// @vitest-environment jsdom
// The Home chat view: the Thread's look on the Home chat routes. Names over
// runs, the typing line, reactions from the hold menu (quick emoji on top)
// and chips, Reply (chip, replyTo, quote strip and its jump), the call
// record line's Call back hook, read acks and view, and the channel's
// members sheet with Delete's "Keep it".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HomeChatMessage } from "../../api/homeChatPure";
import type { SewCallId } from "../../api/homeChatCallsPure";

const api = vi.hoisted(() => ({
  fetchHomeChatMessages: vi.fn(),
  fetchHomeChatPeople: vi.fn(),
  fetchHomeChatReactors: vi.fn(),
  fetchHomeChatMembers: vi.fn(),
  openHomeChatDm: vi.fn(),
  reactHomeChat: vi.fn(),
  sendHomeChatMessage: vi.fn(),
  typingHomeChat: vi.fn(),
  ackHomeChat: vi.fn(async () => ({ ok: true })),
  viewHomeChat: vi.fn(async () => ({ ok: true, joined: false })),
  addHomeChatPeople: vi.fn(),
  deleteHomeChatChannel: vi.fn(),
  leaveHomeChatChannel: vi.fn(),
  removeHomeChatPerson: vi.fn(),
  renameHomeChatChannel: vi.fn(),
  homeChatGateNow: vi.fn(() => ({ feature: true, on: true })),
  onHomeChatGate: vi.fn(() => () => {}),
}));
vi.mock("../../api/homeChat", () => ({ ...api, HOME_CHAT_PAGE_DEFAULT: 50, HOME_CHAT_PAGE_MAX: 100 }));
const events = vi.hoisted(() => ({ subscribeHomeChat: vi.fn(() => () => {}) }));
vi.mock("../../api/homeChatEvents", () => events);

import { HomeChatView } from "./HomeChatView";
import { resetHomeChatStore, useHomeChatStore } from "./homeChatStore";
import { __resetHomeChatActionsForTests } from "./homeChatActions";
import { convKey, type HomeChatTarget } from "./homeChatModel";
import { useServersStore } from "../../stores/servers";
import { useStashStore } from "../stash/stashStore";

const ME = "1";
const ANA = "2";
const BEN = "3";

function msg(id: string, author: string, body: string, over: Partial<HomeChatMessage> = {}): HomeChatMessage {
  return {
    id,
    conv: "9",
    authorId: author,
    body,
    createdAtMs: Date.now() - (100 - Number(id)) * 1000,
    seq: Number(id),
    reactions: [],
    replyTo: null,
    edited: false,
    editedAtMs: null,
    deleted: false,
    nonce: null,
    call: null,
    ...over,
  };
}

const DM: HomeChatTarget = { serverId: "s1", kind: "dm", conversationId: "9", title: "Ana", ext: "k2:connect:ana" };
const CHANNEL: HomeChatTarget = { serverId: "s1", kind: "channel", conversationId: "9", title: "design", inviteOnly: false };
const KEY = convKey("s1", "9");

function seed(messages: HomeChatMessage[], hasMore = false) {
  const st = useHomeChatStore.getState();
  st.setPeople("s1", {
    me: { ext: "k2:connect:me", memberId: ME },
    people: [
      { ext: "k2:connect:ana", username: "ana", displayName: "Ana Diaz", picture: null, role: null, ready: true, memberId: ANA },
      { ext: "k2:connect:ben", username: "ben", displayName: "Ben Ito", picture: null, role: null, ready: true, memberId: BEN },
    ],
  });
  st.patchConv(KEY, { messages, hasMore, loaded: true });
}

beforeEach(() => {
  resetHomeChatStore();
  __resetHomeChatActionsForTests();
  for (const f of Object.values(api)) if ("mockClear" in f) f.mockClear();
  api.fetchHomeChatMessages.mockReset();
  // The view's own reads never answer unless a test says so.
  api.fetchHomeChatMessages.mockReturnValue(new Promise(() => {}));
  api.fetchHomeChatMembers.mockReturnValue(new Promise(() => {}));
  api.reactHomeChat.mockResolvedValue({ ok: true, message: null });
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Studio", url: "https://x.invalid", username: "sam", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("the DM", () => {
  it("draws runs in the Thread's look: the other person's name, your bubble on the accent", () => {
    seed([msg("10", ANA, "hi"), msg("11", ANA, "there"), msg("12", ME, "hello")]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    expect(screen.getByTestId("home-chat-title").textContent).toBe("Ana Diaz");
    expect(screen.getAllByTestId("home-chat-msg-name").map((n) => n.textContent)).toEqual(["Ana Diaz"]);
    const bubbles = screen.getAllByTestId("home-chat-bubble");
    expect(bubbles[2].style.background).toBe("var(--color-accent-fill)");
    expect(bubbles[0].style.background).toBe("var(--color-bubble-agent)");
    expect(screen.getByTestId("home-chat-composer-input").getAttribute("placeholder")).toBe("Message Ana Diaz");
    // On screen: view open, ack the newest.
    expect(api.viewHomeChat).toHaveBeenCalledWith(expect.anything(), "9", true);
    expect(api.ackHomeChat).toHaveBeenCalledWith(expect.anything(), "9");
  });

  it("shows who is typing on the composer's edge", () => {
    seed([msg("10", ANA, "hi")]);
    useHomeChatStore.setState({ typing: { [KEY]: { [ANA]: Date.now() + 5000 } } });
    render(<HomeChatView target={DM} onBack={() => {}} />);
    expect(screen.getByTestId("home-chat-typing-words").textContent).toBe("Ana Diaz is typing");
  });

  it("reacts from the hold menu's quick row, and a chip toggles yours", async () => {
    seed([msg("10", ANA, "hi", { reactions: [{ emoji: "🎉", count: 2, me: false }] })]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    const menu = screen.getByTestId("home-chat-menu");
    // The emoji bar floats on its own above the lifted message.
    const bar = screen.getByTestId("home-chat-menu-head");
    expect(within(menu).queryAllByTestId("home-chat-quick-reaction")).toHaveLength(0);
    expect(within(bar).getAllByTestId("home-chat-quick-reaction").map((b) => b.textContent)).toEqual(["👍", "❤️", "😂", "🎉", "😮", "🙏"]);
    expect(Array.from(menu.querySelectorAll("[role=menuitem]")).map((b) => b.getAttribute("data-testid"))).toEqual([
      "menu-reply",
      "menu-copy",
      "menu-stash",
      "menu-more-emoji",
    ]);
    fireEvent.click(within(bar).getAllByTestId("home-chat-quick-reaction")[0]);
    expect(api.reactHomeChat).toHaveBeenCalledWith(expect.anything(), { conv: "9", msg: "10", emoji: "👍", on: true });
    await waitFor(() => expect(screen.queryByTestId("home-chat-menu")).toBeNull());
    const chips = screen.getAllByTestId("home-chat-reaction");
    expect(chips.map((c) => c.getAttribute("data-emoji"))).toEqual(["🎉", "👍"]);
    expect(chips[1].hasAttribute("data-mine")).toBe(true);
    fireEvent.click(chips[0]);
    expect(api.reactHomeChat).toHaveBeenLastCalledWith(expect.anything(), { conv: "9", msg: "10", emoji: "🎉", on: true });
  });

  it("More emoji… opens the search sheet and reacts with the pick", () => {
    seed([msg("10", ANA, "hi")]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    fireEvent.click(screen.getByTestId("menu-more-emoji"));
    const sheet = screen.getByTestId("home-chat-emoji-sheet");
    fireEvent.change(within(sheet).getByTestId("home-chat-emoji-search"), { target: { value: "rocket" } });
    const found = within(sheet).getAllByTestId("home-chat-emoji");
    expect(found.map((b) => b.getAttribute("data-emoji"))).toEqual(["🚀"]);
    fireEvent.click(found[0]);
    expect(api.reactHomeChat).toHaveBeenCalledWith(expect.anything(), { conv: "9", msg: "10", emoji: "🚀", on: true });
    expect(screen.queryByTestId("home-chat-emoji-sheet")).toBeNull();
  });

  it("replies: the chip above the box, × cancels, Send carries replyTo", async () => {
    seed([msg("10", ANA, "first line\nsecond")]);
    api.sendHomeChatMessage.mockResolvedValue({ ok: true, message: null });
    render(<HomeChatView target={DM} onBack={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    fireEvent.click(screen.getByTestId("menu-reply"));
    expect(screen.getByTestId("home-chat-reply-chip").textContent).toContain("Replying to Ana Diaz: first line");
    fireEvent.click(screen.getByTestId("home-chat-reply-cancel"));
    expect(screen.queryByTestId("home-chat-reply-chip")).toBeNull();

    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    fireEvent.click(screen.getByTestId("menu-reply"));
    fireEvent.change(screen.getByTestId("home-chat-composer-input"), { target: { value: "sure" } });
    fireEvent.submit(screen.getByTestId("home-chat-composer-form"));
    await waitFor(() => expect(api.sendHomeChatMessage).toHaveBeenCalled());
    const sent = api.sendHomeChatMessage.mock.calls[0][1];
    expect(sent).toMatchObject({ conv: "9", text: "sure", replyTo: "10" });
    expect(sent.nonce).toMatch(/.+/);
    expect(screen.queryByTestId("home-chat-reply-chip")).toBeNull();
    // The optimistic reply shows its quote strip at once.
    expect(screen.getByTestId("home-chat-quote").textContent).toContain("Ana Diaz: first line");
  });

  it("a failed send stays as Not sent · Retry, and Retry reuses its nonce", async () => {
    seed([msg("10", ANA, "hi")]);
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: false, kind: "server", code: "sew_error", hint: "Sew is down", status: 502 });
    render(<HomeChatView target={DM} onBack={() => {}} />);
    fireEvent.change(screen.getByTestId("home-chat-composer-input"), { target: { value: "ping" } });
    fireEvent.submit(screen.getByTestId("home-chat-composer-form"));
    await screen.findByTestId("home-chat-retry");
    expect(screen.getByTestId("home-chat-note").textContent).toBe("Not sent (Sew is down). Tap Retry on the message to send it again.");
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    fireEvent.click(screen.getByTestId("home-chat-retry"));
    await waitFor(() => expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(2));
    expect(api.sendHomeChatMessage.mock.calls[1][1].nonce).toBe(api.sendHomeChatMessage.mock.calls[0][1].nonce);
  });

  it("the quote strip jumps to a loaded original with the accent wash", async () => {
    seed([msg("10", ANA, "the original"), msg("11", ME, "reply", { replyTo: "10" })]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
      f(0);
      return 0;
    });
    fireEvent.click(screen.getByTestId("home-chat-quote"));
    await screen.findByTestId("home-chat-wash");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("pages back up to 20 pages for an original, then says it isn't loaded, with Load it", async () => {
    seed([msg("50", ME, "reply", { replyTo: "5" })], true);
    let n = 0;
    api.fetchHomeChatMessages.mockImplementation(async (_s: unknown, _c: string, o: { before?: string }) => {
      if (!o.before) return new Promise(() => {});
      n += 1;
      return { ok: true, conv: "9", messages: [msg(String(1000 + n), ANA, "x")], hasMore: true };
    });
    render(<HomeChatView target={DM} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("home-chat-quote"));
    });
    await screen.findByTestId("home-chat-jump-miss");
    expect(n).toBe(20);
    expect(screen.getByTestId("home-chat-jump-miss").textContent).toContain("Original not loaded.");
    expect(screen.getByTestId("home-chat-jump-more")).toBeTruthy();
  });

  it("says the original was deleted once the history runs out", async () => {
    seed([msg("50", ME, "reply", { replyTo: "5" })], true);
    api.fetchHomeChatMessages.mockImplementation(async (_s: unknown, _c: string, o: { before?: string }) =>
      o.before ? { ok: true, conv: "9", messages: [msg("40", ANA, "x")], hasMore: false } : new Promise(() => {})
    );
    render(<HomeChatView target={DM} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("home-chat-quote"));
    });
    expect((await screen.findByTestId("home-chat-jump-miss")).textContent).toBe("Original message deleted.");
  });

  it("draws a call's record as a line, with Call back on the injected hook", () => {
    const call = {
      callId: "5" as SewCallId,
      startedBy: ANA,
      ended: true,
      endReason: "no_answer",
      durationMs: null,
      joinedIds: [ANA],
      rungIds: [ME],
      declinedIds: [],
      missedIds: [ME],
    };
    seed([msg("10", ANA, "", { call })]);
    const onCallBack = vi.fn();
    render(<HomeChatView target={DM} onBack={() => {}} onCallBack={onCallBack} headerActions={<button data-testid="call-btn">Call</button>} />);
    expect(screen.queryByTestId("home-chat-bubble")).toBeNull();
    expect(screen.getByTestId("home-chat-call-text").textContent).toBe("Missed call");
    fireEvent.click(screen.getByTestId("home-chat-call-back"));
    expect(onCallBack).toHaveBeenCalledWith({ serverId: "s1", kind: "dm", conversationId: "9", title: "Ana Diaz", ext: "k2:connect:ana" });
    expect(within(screen.getByTestId("home-chat-header-actions")).getByTestId("call-btn")).toBeTruthy();
  });
});

describe("the channel", () => {
  const members = {
    conv: "9",
    slug: "c-x",
    state: "active",
    name: "design",
    open: true,
    inviteOnly: false,
    creator: "k2:connect:me",
    allowAgents: false,
    people: [
      { ext: "k2:connect:me", state: "in" },
      { ext: "k2:connect:ana", state: "in" },
    ],
    agents: [],
  };

  it("names every run of someone else's", () => {
    seed([msg("10", ANA, "a"), msg("11", BEN, "b"), msg("12", ANA, "c")]);
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    expect(screen.getAllByTestId("home-chat-msg-name").map((n) => n.textContent)).toEqual(["Ana Diaz", "Ben Ito", "Ana Diaz"]);
    expect(screen.getByTestId("home-chat-title").textContent).toBe("#design");
  });

  it("the header opens the members sheet; Delete asks with Keep it focused", async () => {
    seed([msg("10", ANA, "a")]);
    useHomeChatStore.getState().setChannel(KEY, members);
    api.fetchHomeChatMembers.mockResolvedValue({ ok: true, members });
    api.deleteHomeChatChannel.mockResolvedValue({ ok: true, archived: true });
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("home-chat-title-button"));
    const sheet = await screen.findByTestId("home-chat-members");
    const rows = within(sheet).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["SYouCreated it", "ADAna Diaz"]);
    expect(within(sheet).getByTestId("home-chat-invite")).toBeTruthy();
    expect(within(sheet).getByTestId("home-chat-rename")).toBeTruthy();
    expect(within(sheet).getByTestId("home-chat-leave")).toBeTruthy();
    fireEvent.click(within(sheet).getByTestId("home-chat-delete"));
    const ask = screen.getByTestId("home-chat-delete-confirm");
    expect(within(ask).getByTestId("home-chat-delete-confirm-title").textContent).toBe("Delete #design?");
    const keep = within(ask).getByTestId("home-chat-delete-confirm-cancel");
    expect(keep.textContent).toBe("Keep it");
    expect(document.activeElement).toBe(keep);
    fireEvent.click(within(ask).getByTestId("home-chat-delete-confirm-go"));
    await waitFor(() => expect(api.deleteHomeChatChannel).toHaveBeenCalledWith(expect.anything(), "9"));
  });

  it("invites people from a checklist", async () => {
    seed([msg("10", ANA, "a")]);
    useHomeChatStore.getState().setChannel(KEY, members);
    api.fetchHomeChatMembers.mockResolvedValue({ ok: true, members });
    api.addHomeChatPeople.mockResolvedValue({ ok: true, results: [{ ext: "k2:connect:ben", outcome: "added", code: null }] });
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("home-chat-title-button"));
    fireEvent.click(await screen.findByTestId("home-chat-invite"));
    const people = screen.getAllByTestId("home-chat-invite-person");
    expect(people.map((p) => p.textContent)).toEqual(["BIBen Ito"]);
    fireEvent.click(people[0]);
    fireEvent.click(screen.getByTestId("home-chat-invite-confirm"));
    await waitFor(() => expect(api.addHomeChatPeople).toHaveBeenCalledWith(expect.anything(), "9", ["k2:connect:ben"]));
  });

  it("an archived channel is read-only", () => {
    seed([msg("10", ANA, "a")]);
    useHomeChatStore.getState().setChannel(KEY, { ...members, state: "archived" });
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    expect(screen.getByTestId("home-chat-readonly").textContent).toBe("This channel is archived: it is read-only.");
    expect(screen.queryByTestId("home-chat-composer-input")).toBeNull();
  });
});

describe("K2 Design's review (4.3.0)", () => {
  it("the hold menu lifts the held message above a dim + blur, on the menu material, the page row hidden under its copy", async () => {
    seed([msg("10", ANA, "hi", { reactions: [{ emoji: "🎉", count: 1, me: false }] }), msg("11", ME, "yo")]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    const row = screen.getAllByTestId("home-chat-msg")[0];
    fireEvent.contextMenu(within(row).getByTestId("home-chat-bubble"));
    const backdrop = screen.getByTestId("home-chat-menu-backdrop");
    expect(backdrop.getAttribute("data-dim")).toBe("1");
    expect(backdrop.style.background).toBe("var(--color-scrim)");
    const menu = screen.getByTestId("home-chat-menu");
    expect(menu.style.background).not.toBe("");
    // The copy: the bubble and its chips (not the name line), no test ids
    // or hold hooks; the page's own hidden under it while it is up.
    const lifted = screen.getByTestId("home-chat-menu-lifted");
    expect(lifted.textContent).toContain("hi");
    expect(lifted.textContent).toContain("🎉");
    expect(lifted.textContent).not.toContain("Ana Diaz");
    expect(lifted.querySelector("[data-testid], [data-message-hold], [data-home-chat-msg], [data-home-chat-lift]")).toBeNull();
    const piece = row.querySelector<HTMLElement>("[data-home-chat-lift]")!;
    expect(piece.style.visibility).toBe("hidden");
    expect(within(row).getByTestId("home-chat-msg-name").textContent).toBe("Ana Diaz");
    expect(screen.getAllByTestId("home-chat-bubble")).toHaveLength(2);
    // Over the Home chat's own layer (z 40), not inside it.
    expect(menu.closest("[data-testid=home-chat-view]")).toBeNull();
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByTestId("home-chat-menu")).toBeNull());
    expect(piece.style.visibility).toBe("");
  });

  it("Save to stash: the Thread's words, the message's text, from the other person (a DM) or the channel", async () => {
    const save = vi.fn(async (_input: { text: string; source?: object }) => "saved" as const);
    useStashStore.setState({ save });
    seed([msg("10", ANA, "keep this")]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    const item = screen.getByTestId("menu-stash");
    expect(item.textContent).toBe("Save to stash");
    expect(item.querySelector("svg")).not.toBeNull();
    fireEvent.click(item);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({
      text: "keep this",
      source: { server_label: "Studio", user: "sam", agent: "k2:connect:ana", agent_name: "Ana Diaz" },
    });
    cleanup();
    seed([msg("10", ANA, "for the room")]);
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("home-chat-bubble"));
    fireEvent.click(screen.getByTestId("menu-stash"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject({ text: "for the room", source: { agent: "9", agent_name: "#design" } });
  });

  it("the floating header fades text under it once the list has scrolled", () => {
    seed([msg("10", ANA, "a"), msg("11", ANA, "b")]);
    render(<HomeChatView target={CHANNEL} onBack={() => {}} />);
    const blur = screen.getByTestId("home-chat-header-blur");
    expect(blur.className).toContain("zen-header-blur--edge");
    expect(blur.getAttribute("data-scrolled")).not.toBe("1");
    const scroller = screen.getByTestId("home-chat-scroller");
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    expect(blur.getAttribute("data-scrolled")).toBe("1");
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(blur.getAttribute("data-scrolled")).toBe("0");
    // The first message starts below the header (and its air).
    expect(scroller.style.paddingTop).toContain("env(safe-area-inset-top)");
  });

  it("chat switched off on a Mac server says so with the server's name", () => {
    api.homeChatGateNow.mockReturnValueOnce({ feature: true, on: false, reason: "mac" } as never);
    seed([]);
    render(<HomeChatView target={DM} onBack={() => {}} />);
    expect(screen.getByTestId("home-chat-off").textContent).toBe("Chat isn’t available on Studio. It needs a Linux server.");
  });
});
