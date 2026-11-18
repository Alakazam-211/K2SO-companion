// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  callBack: vi.fn(),
  callPersonFromRow: vi.fn(async () => ({ ok: true })),
  open: null as null | ((r: { serverId: string; conversationId: string }) => void),
}));
vi.mock("../calls", () => ({
  DmCallButton: () => null,
  callBack: calls.callBack,
  callPersonFromRow: calls.callPersonFromRow,
  onOpenHomeChat: (fn: (r: { serverId: string; conversationId: string }) => void) => {
    calls.open = fn;
    return () => {
      calls.open = null;
    };
  },
}));

import { wireHomeChatCalls } from "./wireCalls";
import { useHomeChatCallHooks, useHomeChatStore } from "./homeChatStore";
import { callPersonFromRow as rowCall } from "./openHomeChat";

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
  vi.clearAllMocks();
});

describe("Home's call seams, joined", () => {
  it("the chat view's Call back rings through the calls part", () => {
    off = wireHomeChatCalls();
    const hooks = useHomeChatCallHooks.getState();
    expect(hooks.HeaderActions).toBeTypeOf("function");
    hooks.onCallBack?.({ serverId: "s1", kind: "dm", conversationId: "123", title: "Maya", ext: null });
    expect(calls.callBack).toHaveBeenCalledWith("s1", "123", "Maya");
  });

  it("a person row's long-press Call reaches callPersonFromRow", () => {
    off = wireHomeChatCalls();
    rowCall("s1", { ext: "k2:connect:abc", displayName: "Maya Chen", username: "maya", conversationId: "123" });
    expect(calls.callPersonFromRow).toHaveBeenCalledWith("s1", {
      ext: "k2:connect:abc",
      displayName: "Maya Chen",
      username: "maya",
      conv: "123",
    });
  });

  it("a call notification's tap opens the DM", () => {
    off = wireHomeChatCalls();
    calls.open?.({ serverId: "s1", conversationId: "456" });
    const open = useHomeChatStore.getState();
    expect(JSON.stringify(open)).toContain("456");
  });

  it("unwiring clears the hooks", () => {
    wireHomeChatCalls()();
    expect(useHomeChatCallHooks.getState().onCallBack).toBeUndefined();
  });
});
