// @vitest-environment jsdom
// The entry point: openHomeChat shows the view over Zen; Back (the header
// or Android Back) closes it. A DM known only by person is opened first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
  fetchHomeChatMessages: vi.fn(() => new Promise(() => {})),
  fetchHomeChatPeople: vi.fn(() => new Promise(() => {})),
  fetchHomeChatMembers: vi.fn(() => new Promise(() => {})),
  openHomeChatDm: vi.fn(async () => ({ ok: true, conv: "44", created: false })),
  ackHomeChat: vi.fn(async () => ({ ok: true })),
  viewHomeChat: vi.fn(async () => ({ ok: true, joined: false })),
  homeChatGateNow: vi.fn(() => ({ feature: true, on: true })),
  onHomeChatGate: vi.fn(() => () => {}),
}));
vi.mock("../../api/homeChat", () => ({ ...api, HOME_CHAT_PAGE_DEFAULT: 50, HOME_CHAT_PAGE_MAX: 100 }));
vi.mock("../../api/homeChatEvents", () => ({ subscribeHomeChat: vi.fn(() => () => {}) }));

import { HomeChatHost } from "./HomeChatHost";
import { openHomeChat, resetHomeChatStore, setHomeChatCallHooks, useHomeChatStore } from "./homeChatStore";
import { handleAndroidBack } from "../../lib/androidBack";

beforeEach(() => resetHomeChatStore());
afterEach(() => {
  cleanup();
  setHomeChatCallHooks({});
});

describe("HomeChatHost", () => {
  it("shows the chat openHomeChat names, and Back closes it", async () => {
    render(<HomeChatHost />);
    expect(screen.queryByTestId("home-chat-view")).toBeNull();
    await act(async () => openHomeChat({ serverId: "s1", kind: "channel", conversationId: "9", title: "design" }));
    expect(screen.getByTestId("home-chat-view").getAttribute("data-kind")).toBe("channel");
    expect(screen.getByTestId("home-chat-title").textContent).toBe("#design");
    fireEvent.click(screen.getByTestId("home-chat-back"));
    expect(useHomeChatStore.getState().open).toBeNull();
    expect(screen.queryByTestId("home-chat-view")).toBeNull();
  });

  it("opens a DM by person, renders the registered Call button, and Android Back closes", async () => {
    setHomeChatCallHooks({
      HeaderActions: ({ conversation }) => <button data-testid="call">{conversation?.conversationId ?? "…"}</button>,
    });
    render(<HomeChatHost />);
    await act(async () => openHomeChat({ serverId: "s1", kind: "dm", conversationId: null, title: "Ana", ext: "k2:connect:ana" }));
    expect(api.openHomeChatDm).toHaveBeenCalledWith(expect.anything(), "k2:connect:ana");
    expect((await screen.findByTestId("call")).textContent).toBe("44");
    act(() => {
      handleAndroidBack();
    });
    expect(useHomeChatStore.getState().open).toBeNull();
  });
});
